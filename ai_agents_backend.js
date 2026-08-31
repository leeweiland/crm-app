import { randomUUID } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { getContactMessages } from "./message_index.js";
import { retrieveFromCache, formatChunksForPrompt, invalidateCache } from "./data/retrieval.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRITING_CACHE_PATH = join(__dirname, "data", "chunks_cache.json");
const SALES_CACHE_PATH = join(__dirname, "data", "sales_convos_cache.json");

// Static baseline context every agent gets regardless of what retrieval
// happens to surface for a given message -- the real pricing structure and
// a handful of full real closed-won conversations. Retrieval (below) adds
// *more* relevant material on top of this per-message, it doesn't replace
// it -- an agent should never be pricing purely from memory/retrieval alone.
const PLAYBOOK = readFileSync(join(__dirname, "data", "alexis_playbook.md"), "utf8");
const FEW_SHOT = JSON.parse(readFileSync(join(__dirname, "data", "few_shot_examples.json"), "utf8"));
function formatExampleConvo(example) {
  const lines = example.conversation.map((e) => {
    const speaker = e.direction === "inbound" || e.direction === "incoming" ? "LEAD" : "AGENT";
    return `${speaker} (${e.channel}): ${e.text.replace(/\n+/g, " / ").trim()}`;
  });
  return `### Real closed-won example — ${example.name}\n${lines.join("\n")}`;
}
const FEW_SHOT_BLOCK = FEW_SHOT.map(formatExampleConvo).join("\n\n");

export const AI_AGENTS_FILE = "crm_ai_agents.json";

// ── Daily writing-archive cache sync ──────────────────────────────────────
// chunks_cache.json (Lee's writing archive, embedded for retrieval) is
// already rebuilt every morning by a separate GitHub Actions pipeline in
// the online-daily-video-email repo -- crm-app doesn't re-scrape Drive or
// re-embed anything itself, it just pulls the latest already-built file
// once a day. Same "cheap no-op unless a day has passed" gating pattern as
// duplicates_backend.js's runScheduledDuplicateScan, called from the same
// scheduler.js tick().
const CACHE_SYNC_STATE_FILE = "crm_cache_sync_state.json";
const CACHE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_REPO = "leeweiland/online-daily-video-email";

export async function syncWritingCacheIfDue() {
  const state = readJson(CACHE_SYNC_STATE_FILE, { lastSyncAt: null });
  if (state.lastSyncAt && Date.now() - new Date(state.lastSyncAt).getTime() < CACHE_SYNC_INTERVAL_MS) return;
  if (!process.env.GITHUB_TOKEN) { console.error("[ai-cache-sync] GITHUB_TOKEN not set, skipping"); return; }
  try {
    const res = await fetch(`https://api.github.com/repos/${CACHE_REPO}/contents/chunks_cache.json`, {
      headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw" },
    });
    if (!res.ok) throw new Error(`GitHub fetch ${res.status}: ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(WRITING_CACHE_PATH, buf);
    invalidateCache(WRITING_CACHE_PATH);
    state.lastSyncAt = new Date().toISOString();
    writeJson(CACHE_SYNC_STATE_FILE, state);
    console.log(`[ai-cache-sync] refreshed chunks_cache.json (${(buf.length / 1e6).toFixed(1)}MB)`);
  } catch (err) {
    console.error("[ai-cache-sync] failed:", err.message);
  }
}

// Default seed prompt for a brand-new agent -- same shape/content as the
// sales-agent prototype's DEFAULT_INSTRUCTIONS, so agents created here start
// from the same known-working baseline rather than a blank box.
const DEFAULT_SYSTEM_PROMPT = `VOICE SWITCHING — use whichever of these two voices actually fits what's being asked:
- LEE'S VOICE: when answering questions about the training program itself, methodology, philosophy, why it works, what's included — speak in Lee Weiland's own language, pulled from his writing archive: "Body Mastery," "Superhuman Strength, Skill, and Athletic Longevity," "bulletproofs you for life." Don't say "fully custom online coaching" — say what Lee actually says.
- ALEXIS'S VOICE: when handling pricing, objections, negotiation, scheduling, or closing — speak the way Alexis actually texts in the real closed-won conversations: short, casual, transactional, warm. Never corporate.

CLOSING BEHAVIOR — go for the sale, not the call:
- Never offer "hop on a quick call with a Coach" as an easy alternative path when a lead asks about pricing or the program. Alexis does not hedge toward scheduling as a way to defer giving pricing.
- Always give pricing directly and move toward closing. A call, if one ever happens, comes AFTER pricing is on the table and the lead is already leaning in — never offered as a way to avoid answering "how much."
- Never re-explain value after a "no" — accept it and move on. Never lower the total price to overcome an objection — restructure the payment plan instead. Let the lead do their own math and talk themselves into it rather than being told what to think.

REUSE REAL LANGUAGE, DON'T INVENT NEW LINES: when retrieved material or example transcripts contain a real sentence that fits the moment, use that actual sentence instead of writing your own version "in the spirit of" it.`;

function newAgent({ name, description }) {
  return {
    id: randomUUID(),
    name: name || "Untitled Agent",
    description: description || "",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    active: false, // agents start OFF -- an admin must deliberately activate one, never on-by-default
    aiAssist: false, // when true (and active, and the lead matches targeting), a real inbound message from
                      // a matching lead auto-generates a reply and surfaces it in the Inbox for review (or
                      // sends it directly if sendMode is 'auto'). When false, the agent only responds when
                      // manually chatted with from the AI Agents page -- never touches real conversations.
    targeting: {
      programTypes: [], // [] = all types (online/gym); non-empty = only these
      statuses: [],     // [] = all statuses; non-empty = only these
      coverForUserIds: [], // human users this agent "steps in for" when they're away
    },
    sendMode: "draft", // 'draft' (reply saved for human review) | 'auto' (sends immediately) -- defaults to the safe option
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Formats one contact's full real history -- SMS, email, and any other
// logged activity (ad clicks, etc, since logMessage() covers all channels)
// -- into a readable timeline. Backed by getContactMessages(contactId),
// which reads the per-contact shard (msg_by_contact/<id>.json), NOT the
// main message log -- safe regardless of how large that log grows.
function formatCustomerJourney(contact, journey) {
  if (!contact) return "";
  const lines = journey
    .slice(-60) // most recent 60 events is plenty of context; keeps the prompt bounded
    .map((m) => {
      const dir = m.direction === "inbound" ? "FROM LEAD" : m.direction === "outbound" ? "TO LEAD" : m.direction || "";
      const when = (m.createdAt || m.at || "").slice(0, 16);
      const label = m.subject || m.sourceType || m.channel;
      const body = (m.bodyPreview || m.body || "").slice(0, 300);
      return `[${when}] ${m.channel}${dir ? " " + dir : ""} — ${label}${body ? ": " + body : ""}`;
    });
  return `\n\n### CUSTOMER JOURNEY — real history for this specific lead (${contact.first || ""} ${contact.last || ""}, ${contact.email || contact.phone || "no contact info"})\nStatus: ${contact.status || "unknown"} · Type: ${contact.programType || "unknown"} · Lead since: ${contact.firstSeenAt || contact.createdAt || "unknown"}\n\n${lines.join("\n") || "(no prior activity on record)"}`;
}

async function retrieveBoth(query) {
  const [salesChunks, writingChunks] = await Promise.all([
    retrieveFromCache(SALES_CACHE_PATH, query, { topN: 6 }).catch((e) => {
      console.error("sales cache retrieve failed:", e.message);
      return [];
    }),
    retrieveFromCache(WRITING_CACHE_PATH, query, { topN: 8 }).catch((e) => {
      console.error("writing cache retrieve failed:", e.message);
      return [];
    }),
  ]);
  let block = "";
  if (salesChunks.length) block += formatChunksForPrompt(salesChunks, `LIVE-RETRIEVED MATERIAL — real past sales conversations relevant to: "${query}"`);
  if (writingChunks.length) block += formatChunksForPrompt(writingChunks, `LIVE-RETRIEVED MATERIAL — Lee's writing archive relevant to: "${query}"`);
  return block;
}

function buildAgentSystemPrompt(agent, journeyBlock) {
  const sendModeNote = agent.sendMode === "draft"
    ? "Your replies are DRAFTS only -- a human reviews and approves before anything is sent to the real lead. Write as if sending directly; the review step is invisible to you."
    : "Your replies are sent directly to the real lead with no human review. Be certain before committing to a claim, price, or promise.";
  return `You are "${agent.name}", an AI agent for Pacific Rim Athletics. ${agent.description || ""}

${sendModeNote}

${agent.systemPrompt || ""}

Below is the real pricing/objection-handling playbook and a handful of full real closed-won conversations. Never invent pricing or numbers that aren't grounded in this material or in LIVE-RETRIEVED MATERIAL appended below -- if you're not sure of a real number, say something true and general rather than making one up.

${PLAYBOOK}

${FEW_SHOT_BLOCK}
${journeyBlock}
`;
}

export const AI_DRAFTS_FILE = "crm_ai_drafts.json";

// Non-streaming version of the chat call -- used by the AI Assist auto-trigger
// (no one's watching a UI stream it in), where only the final text matters.
async function generateAgentReply(agent, contactId, userText) {
  let journeyBlock = "";
  if (contactId) {
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find((c) => c.id === contactId);
    const journey = getContactMessages(contactId);
    journeyBlock = formatCustomerJourney(contact, journey);
  }
  const grounding = await retrieveBoth(userText);
  const systemPrompt = buildAgentSystemPrompt(agent, journeyBlock) + grounding;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!anthropicRes.ok) throw new Error(`Anthropic error ${anthropicRes.status}: ${await anthropicRes.text()}`);
  const data = await anthropicRes.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock?.text || "";
}

// Does this contact match an agent's targeting rules? Empty targeting arrays
// mean "no restriction on this dimension" -- matches everyone.
function contactMatchesTargeting(contact, targeting) {
  if (!targeting) return true;
  if (targeting.programTypes?.length && !targeting.programTypes.includes(contact.programType)) return false;
  if (targeting.statuses?.length && !targeting.statuses.includes(contact.status)) return false;
  return true;
}

// On-demand only -- generation happens exactly when a human opens this
// contact's conversation (the Inbox already calls GET /api/ai-drafts with
// contactId every time a conversation is selected; see the route below),
// never on a timer and never reacting automatically to an inbound message
// arriving. A periodic sweep across every contact with an unanswered
// message would burn API credits on conversations nobody's about to look
// at yet; checking only the one contact someone actually clicked into
// costs nothing extra for everyone else.
//
// "Active" gates whether the agent can be invoked at all; "AI Assist"
// gates whether that specific agent drafts replies. Both are required, but
// neither implies constant background work -- the work only happens at
// the moment of the click.
async function maybeGenerateAiAssistDraft(contactId) {
  if (!contactId) return;
  const contacts = readJson(CONTACTS_FILE, []);
  const contact = contacts.find((c) => c.id === contactId);
  if (!contact) return;
  const agents = readJson(AI_AGENTS_FILE, []);
  const agent = agents.find((a) => a.active && a.aiAssist && contactMatchesTargeting(contact, a.targeting));
  if (!agent) return;

  const journey = getContactMessages(contactId);
  if (!journey.length) return;
  const last = [...journey].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).at(-1);
  if (last.direction !== "inbound") return; // nothing unanswered to draft a reply to

  const drafts = readJson(AI_DRAFTS_FILE, []);
  if (drafts.some((d) => d.agentId === agent.id && d.sourceMessageId === last.id)) return; // already drafted for this exact message

  try {
    const replyText = await generateAgentReply(agent, contactId, last.body || last.bodyPreview || "");
    if (!replyText) return;
    drafts.push({
      id: randomUUID(), agentId: agent.id, agentName: agent.name, contactId,
      channel: last.channel, draftText: replyText, sourceMessageId: last.id,
      status: "pending", createdAt: new Date().toISOString(),
    });
    writeJson(AI_DRAFTS_FILE, drafts);
  } catch (err) {
    console.error(`[ai-assist] agent ${agent.id} contact ${contactId} failed:`, err.message);
  }
}

export async function handleAiAgentsRequest(req, res, url) {
  const p0 = url.pathname;

  if (p0 === "/api/ai-drafts" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const contactId = url.searchParams.get("contactId");
    // The Inbox calls this exact route with contactId every time a
    // conversation is opened -- that's the one and only trigger point for
    // AI Assist generation (see maybeGenerateAiAssistDraft's comment).
    if (contactId) await maybeGenerateAiAssistDraft(contactId);
    let drafts = readJson(AI_DRAFTS_FILE, []).filter((d) => d.status === "pending");
    if (contactId) drafts = drafts.filter((d) => d.contactId === contactId);
    return sendJson(res, 200, { drafts });
  }
  const draftSendMatch = p0.match(/^\/api\/ai-drafts\/([^/]+)\/send$/);
  if (draftSendMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const drafts = readJson(AI_DRAFTS_FILE, []);
    const draft = drafts.find((d) => d.id === draftSendMatch[1]);
    if (!draft) return sendJson(res, 404, { error: "Draft not found" });
    const body = await readJsonBody(req);
    const { sendSms } = await import("./sms_backend.js");
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find((c) => c.id === draft.contactId);
    if (!contact?.phone) return sendJson(res, 400, { error: "Contact has no phone number" });
    const finalText = body.editedText ?? draft.draftText;
    await sendSms({ to: contact.phone, body: finalText, contactId: contact.id, sourceType: "ai_agent", sourceId: draft.agentId });
    draft.status = "sent";
    draft.sentText = finalText;
    writeJson(AI_DRAFTS_FILE, drafts);
    return sendJson(res, 200, { ok: true });
  }
  const draftDiscardMatch = p0.match(/^\/api\/ai-drafts\/([^/]+)\/discard$/);
  if (draftDiscardMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const drafts = readJson(AI_DRAFTS_FILE, []);
    const draft = drafts.find((d) => d.id === draftDiscardMatch[1]);
    if (!draft) return sendJson(res, 404, { error: "Draft not found" });
    draft.status = "discarded";
    writeJson(AI_DRAFTS_FILE, drafts);
    return sendJson(res, 200, { ok: true });
  }

  const chatMatch = url.pathname.match(/^\/api\/ai-agents\/([^/]+)\/chat$/);
  if (chatMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });

    const agents = readJson(AI_AGENTS_FILE, []);
    const savedAgent = agents.find((a) => a.id === chatMatch[1]);
    if (!savedAgent) return sendJson(res, 404, { error: "Agent not found" });

    try {
      const { messages, contactId, agentDraft } = await readJsonBody(req);
      if (!Array.isArray(messages) || !messages.length) return sendJson(res, 400, { error: "messages array required" });
      // Test chat from the editor should reflect whatever's in the form right
      // now, not just what's already saved -- lets you tweak the system
      // prompt and immediately try it without saving first.
      const agent = agentDraft && typeof agentDraft === "object" ? { ...savedAgent, ...agentDraft } : savedAgent;

      let journeyBlock = "";
      if (contactId) {
        const contacts = readJson(CONTACTS_FILE, []);
        const contact = contacts.find((c) => c.id === contactId);
        const journey = getContactMessages(contactId);
        journeyBlock = formatCustomerJourney(contact, journey);
      }

      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const grounding = lastUserMsg ? await retrieveBoth(lastUserMsg.content) : "";
      const systemPrompt = buildAgentSystemPrompt(agent, journeyBlock) + grounding;

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 2000,
          system: systemPrompt,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
      });

      if (!anthropicRes.ok || !anthropicRes.body) {
        const errText = await anthropicRes.text();
        console.error("Anthropic error:", anthropicRes.status, errText);
        return sendJson(res, 502, { error: "Anthropic API error", detail: errText });
      }

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

      const reader = anthropicRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "content_block_delta" && evt.delta?.text) {
              res.write(`data: ${JSON.stringify({ text: evt.delta.text })}\n\n`);
            } else if (evt.type === "error") {
              console.error("Anthropic stream error event:", JSON.stringify(evt));
            }
          } catch {
            // ignore malformed/partial SSE fragments
          }
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    }
    return true;
  }

  return handleAiAgentsCrud(req, res, url);
}

async function handleAiAgentsCrud(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/ai-agents")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/ai-agents" && req.method === "GET") {
    const agents = readJson(AI_AGENTS_FILE, []);
    return sendJson(res, 200, { agents });
  }
  if (p === "/api/ai-agents" && req.method === "POST") {
    const { name, description } = await readJsonBody(req);
    const agents = readJson(AI_AGENTS_FILE, []);
    const agent = newAgent({ name, description });
    agents.push(agent);
    writeJson(AI_AGENTS_FILE, agents);
    return sendJson(res, 200, { ok: true, agent });
  }

  const agentMatch = p.match(/^\/api\/ai-agents\/([^/]+)$/);
  if (agentMatch) {
    const agents = readJson(AI_AGENTS_FILE, []);
    const agent = agents.find(a => a.id === agentMatch[1]);
    if (req.method === "GET") {
      if (!agent) return sendJson(res, 404, { error: "Agent not found" });
      return sendJson(res, 200, { agent });
    }
    if (req.method === "PATCH") {
      if (!agent) return sendJson(res, 404, { error: "Agent not found" });
      const body = await readJsonBody(req);
      if ("sendMode" in body && !["draft", "auto"].includes(body.sendMode)) {
        return sendJson(res, 400, { error: "sendMode must be 'draft' or 'auto'" });
      }
      for (const k of ["name", "description", "systemPrompt", "active", "aiAssist", "targeting", "sendMode"]) {
        if (k in body) agent[k] = body[k];
      }
      agent.updatedAt = new Date().toISOString();
      writeJson(AI_AGENTS_FILE, agents);
      return sendJson(res, 200, { ok: true, agent });
    }
    if (req.method === "DELETE") {
      if (!agent) return sendJson(res, 404, { error: "Agent not found" });
      writeJson(AI_AGENTS_FILE, agents.filter(a => a.id !== agentMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  return false;
}
