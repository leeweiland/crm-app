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
const DEFAULT_SYSTEM_PROMPT = `IDENTITY & VOICE

- You're an AI sales agent for Pacific Rim Athletics (Powerbatics -- bodyweight strength, skill, and mobility coaching).
- LEE'S VOICE -- use for methodology, program philosophy, what's included, "why this works," and time/price/"let me think about it" objections. Speak in Lee Weiland's own language, pulled from his writing archive: "Body Mastery," "Superhuman Strength, Skill, and Athletic Longevity," "bulletproofs you for life." Blunt, no-nonsense, occasional dry humor. Don't say "fully custom online coaching" -- say what Lee actually says.
- ALEXIS'S VOICE -- use for pricing, payments, objections, negotiation, scheduling, and closing. Short, casual, transactional, warm -- the way Alexis actually texts in the real closed-won conversations. Never corporate.
- Be blunt, but humorous. Fun, but clear. Be positive, not negative -- NEVER open a sentence with "No" or lead with what's unavailable. State the positive option FIRST, every time. Example: instead of "No payment plans, but if you're ready we can do half down and half in 30 days," say "If you're ready to start now, we can do half down and half in 30 days at no upcharge -- that's as flexible as it gets." Only mention what ISN'T available (payment plans, discounts) if the lead specifically keeps pushing after hearing the positive option.

PRIORITY -- APPLYING / SCHEDULING COMES FIRST

- Guide every conversation toward the lead applying or booking a call. Don't volunteer pricing -- only give it when the lead actually asks.
- Never offer "hop on a quick call with a Coach" as an easy way to dodge a pricing question. Give pricing directly, then move toward closing. A call, if one ever happens, comes AFTER pricing is on the table and the lead is already leaning in.
- Answer the lead's actual question directly. Never re-explain value after a "no" -- accept it and move on.

PRICING -- THE ONLY NUMBERS TO EVER USE

- Start with the top tier. Only go into a lower tier if the lead pushes back or asks what else is available.
  - 2 Year: $18,000
  - 1 Year (Athletic Longevity): $10,000
  - 6 Months: $7,000
  - 4 Months: $4,000
  - 4 Months Modified: $3,100
- No payment plans. No discounts. No negotiating the total.
- The ONLY accommodation, and only if the lead genuinely can't do it in full: half down, half in 30 days, on the same total. Never offer this proactively -- only if they ask or say they can't do it in full.
- Never lower the total price to overcome an objection. Let the lead do their own math and talk themselves into it, rather than being told what to think.
- Never invent a number that isn't on this list.

REUSE REAL LANGUAGE, DON'T INVENT NEW LINES

- When retrieved material or example transcripts contain a real sentence that fits the moment, use that actual sentence instead of writing your own version "in the spirit of" it.
- Never repeat something already said earlier in this same conversation -- check the customer journey below before drafting.`;

// Structured-output instructions -- ALWAYS injected by buildAgentSystemPrompt
// below, regardless of what's saved in an individual agent's editable
// systemPrompt box. This is mechanical framework (parseAgentOutput() below
// depends on the model actually using these exact markers), not a stylistic
// choice an admin should be able to accidentally delete by editing the
// prompt -- an agent whose systemPrompt was customized before this existed
// (or edited later without knowing about it) must still get these, or
// AI Active's escalate/hot-handoff/skip transitions silently never fire.
const RESPONSE_FORMAT_INSTRUCTIONS = `WHEN NOT TO DRAFT A NORMAL REPLY -- respond with exactly one of these instead of a message, on its own, as your entire response:
- \`[[NO_RESPONSE_NEEDED: <short reason>]]\` -- the lead's last message doesn't need a reply (e.g. just "thanks", an automated/system notification, or the conversation has already reached a clear conclusion).
- \`[[ESCALATE: <short reason>]]\` -- this needs a human, not a suggested reply: a complaint, a refund request, a medical question, or anything else outside a normal sales conversation.

BUYING SIGNALS -- if the lead is asking how to pay, asking to start, confirming a tier, asking about kickoff, or otherwise signaling they're ready to enroll, still draft the reply normally but end your entire response with \`[[BUYING_SIGNAL]]\` on its own line after the message -- that's the moment a human closer should take over, not a moment to keep running the AI.`;

// The seed prompt for brand-new agents is itself editable from the AI
// Agents panel (a "Default Prompt" button, not tied to any one agent) --
// stored here so a wording change doesn't require a code deploy. Falls
// back to the hardcoded DEFAULT_SYSTEM_PROMPT above until an admin has
// ever saved a custom one.
export const AI_SETTINGS_FILE = "crm_ai_settings.json";
function getDefaultSystemPrompt() {
  const settings = readJson(AI_SETTINGS_FILE, {});
  return settings.defaultSystemPrompt || DEFAULT_SYSTEM_PROMPT;
}

function newAgent({ name, description }) {
  return {
    id: randomUUID(),
    name: name || "Kai",
    description: description || "",
    systemPrompt: getDefaultSystemPrompt(),
    // AI Assist ("helps the human work conversations") and AI Active
    // ("works the selected lead batch independently") are two distinct
    // capabilities on the same agent record. Both start OFF -- an admin
    // must deliberately turn each one on.
    active: false, // AI Active master switch -- also the kill-switch processAiActiveBatches() checks every tick
    aiAssist: false, // AI Assist -- icon-triggered draft generation in the Inbox, always human-reviewed
    targeting: {
      programTypes: [], // [] = all types (online/gym); non-empty = only these
      statuses: [],     // [] = all statuses; non-empty = only these
      coverForUserIds: [], // human users this agent "steps in for" when they're away
    },
    activeConfig: { segmentId: null, batchSize: 25, waitTimeRange: { minHours: 4, maxHours: 24 } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Formats one contact's full real history -- SMS, email, and any other
// logged activity (ad clicks, etc, since logMessage() covers all channels)
// -- into a readable timeline. Backed by getContactMessages(contactId),
// which reads the per-contact shard (msg_by_contact/<id>.json), NOT the
// main message log -- safe regardless of how large that log grows.
export function formatCustomerJourney(contact, journey) {
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

// autoSend is which FEATURE is calling, not a stored agent setting -- AI
// Assist (icon-generate/summarize/test-chat) always lands in front of a
// human first; AI Active always sends immediately. A per-agent "sendMode"
// field used to exist here but was actively misleading (it no longer
// matched what either path actually did), so it's gone -- the truth is
// which code path is asking, passed in explicitly.
export function buildAgentSystemPrompt(agent, journeyBlock, autoSend = false, senderName = null) {
  const sendModeNote = autoSend
    ? "Your replies are sent directly to the real lead with no human review. Be certain before committing to a claim, price, or promise."
    : "Your replies are DRAFTS only -- a human reviews and approves before anything is sent to the real lead. Write as if sending directly; the review step is invisible to you.";
  // The playbook/few-shot material below is full of real transcripts signed
  // "Alexis" -- reusing that PHRASING is the point (see REUSE REAL LANGUAGE
  // in the agent's own prompt), but the NAME is not: a draft should
  // introduce itself as whichever real team member is actually at the
  // keyboard, not whoever happened to send the historical example it was
  // pulled from.
  const senderNote = senderName
    ? `You are drafting this on behalf of ${senderName}, a real team member who is logged in right now. If you introduce yourself or sign off by name, use "${senderName}" -- never a name from an example or past conversation below (e.g. "Alexis"), even though the phrasing/technique from those examples is exactly what you should reuse.`
    : "";
  return `You are "${agent.name}", an AI agent for Pacific Rim Athletics. ${agent.description || ""}

${sendModeNote}
${senderNote}

${agent.systemPrompt || ""}

${RESPONSE_FORMAT_INSTRUCTIONS}

Below is supplementary grounding: real objection-handling phrasing/technique from actual closed-won conversations, and a handful of full real conversations. The pricing above is authoritative -- never use a number from here (or anywhere) that contradicts it.

${PLAYBOOK}

${FEW_SHOT_BLOCK}
${journeyBlock}
`;
}

export const AI_GENERATION_LOG_FILE = "crm_ai_generation_log.json";

// Statuses where the sales conversation is already resolved one way or
// another -- no reply is ever needed regardless of what the last message
// looks like. Skipped before ever calling the model.
export const TERMINAL_STATUSES = new Set(["ENROLLED", "STOP", "BAD FIT / BLACKLIST", "WE CANCELLED"]);
// A human personally sent the last outbound message (not the AI) within
// this window -- they're actively on this lead, don't suggest anything.
const RECENTLY_HUMAN_HANDLED_MS = 6 * 60 * 60 * 1000;
// We already sent the last message and the lead hasn't replied -- don't
// suggest ANOTHER follow-up until this much time has passed. Only applies
// to the "they've gone quiet" case, never to "they just replied".
const RECENT_FOLLOWUP_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Parses the structured markers the system prompt instructs the model to
// use in place of a normal reply (see DEFAULT_SYSTEM_PROMPT above) --
// `[[NO_RESPONSE_NEEDED: reason]]`, `[[ESCALATE: reason]]`, and a trailing
// `[[BUYING_SIGNAL]]` line appended to an otherwise-normal reply.
function parseAgentOutput(raw) {
  const text = (raw || "").trim();
  const noResponse = text.match(/^\[\[NO_RESPONSE_NEEDED:?\s*(.*?)\]\]$/i);
  if (noResponse) return { skip: true, reason: noResponse[1] || "No response needed." };
  const escalate = text.match(/^\[\[ESCALATE:?\s*(.*?)\]\]$/i);
  if (escalate) return { escalate: escalate[1] || "Needs a human." };
  const buyingSignalMatch = text.match(/\n?\[\[BUYING_SIGNAL\]\]\s*$/i);
  const buyingSignal = !!buyingSignalMatch;
  const cleanText = buyingSignalMatch ? text.slice(0, buyingSignalMatch.index).trim() : text;
  return { text: cleanText, buyingSignal };
}

// Non-streaming version of the chat call -- used for on-demand generation
// (no one's watching a UI stream it in), where only the final parsed
// result matters. Returns { text, buyingSignal } on a normal reply,
// { skip: true, reason } when no reply is needed, or { escalate: reason }
// when this needs a human instead of a suggestion.
export async function generateAgentReply(agent, contactId, userText, { autoSend = false, senderName = null } = {}) {
  let journeyBlock = "";
  if (contactId) {
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find((c) => c.id === contactId);
    const journey = getContactMessages(contactId);
    journeyBlock = formatCustomerJourney(contact, journey);
  }
  const grounding = await retrieveBoth(userText);
  const systemPrompt = buildAgentSystemPrompt(agent, journeyBlock, autoSend, senderName) + grounding;

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
  return parseAgentOutput(textBlock?.text || "");
}

// Does this contact match an agent's targeting rules? Empty targeting arrays
// mean "no restriction on this dimension" -- matches everyone.
export function contactMatchesTargeting(contact, targeting) {
  if (!targeting) return true;
  if (targeting.programTypes?.length && !targeting.programTypes.includes(contact.programType)) return false;
  if (targeting.statuses?.length && !targeting.statuses.includes(contact.status)) return false;
  return true;
}

// Only the same channels the Inbox itself treats as a real conversation
// (see inbox.html/contact-detail.html's thread filter) -- excludes
// "activity" rows (automation bookkeeping like "sequence started", which
// can carry direction:"inbound" as a technical artifact despite the lead
// never having said anything) so a draft never gets generated in reply to
// a system note instead of an actual message from them.
export const CONVERSATION_CHANNELS = ["email", "sms", "form", "booking"];

// Everything below the model call is a deterministic, free (no API cost)
// gate -- checked before ever spending a token. Returns a short reason
// string if generation should be skipped, or null if it's fine to proceed.
function whyNotToGenerate(contact, journey) {
  if (contact.status && TERMINAL_STATUSES.has(contact.status)) {
    return `Status is "${contact.status}" -- conversation is already resolved.`;
  }
  const last = journey.length ? journey.at(-1) : null;
  const lastHumanOutbound = [...journey].reverse().find((m) => m.direction === "outbound" && m.sourceType && m.sourceType !== "ai_agent");
  if (lastHumanOutbound) {
    const isLatestOverall = !last || new Date(lastHumanOutbound.createdAt).getTime() >= new Date(last.createdAt).getTime();
    if (isLatestOverall && Date.now() - new Date(lastHumanOutbound.createdAt).getTime() < RECENTLY_HUMAN_HANDLED_MS) {
      return "A staff member just personally messaged this lead -- they're actively on it.";
    }
  }
  if (last && last.direction !== "inbound" && Date.now() - new Date(last.createdAt).getTime() < RECENT_FOLLOWUP_COOLDOWN_MS) {
    return "Already followed up recently -- give it more time before nudging again.";
  }
  return null;
}

function buildPromptForState(journey) {
  const last = journey.length ? journey.at(-1) : null;
  if (!last) return { last: null, promptText: "(No prior messages with this lead yet. Draft an appropriate opening outreach message to them, based on their info and your role.)" };
  if (last.direction === "inbound") return { last, promptText: last.body || last.bodyPreview || "" };
  return { last, promptText: `(The lead hasn't replied since our last message to them: "${last.body || last.bodyPreview || ""}". Draft an appropriate follow-up to re-engage them.)` };
}

function logGeneration(entry) {
  const log = readJson(AI_GENERATION_LOG_FILE, []);
  log.push({ id: randomUUID(), createdAt: new Date().toISOString(), ...entry });
  writeJson(AI_GENERATION_LOG_FILE, log);
}

export async function handleAiAgentsRequest(req, res, url) {
  const p0 = url.pathname;

  // Cheap, no-LLM-call check: is there any AI Assist agent that applies to
  // this contact at all? Powers whether the Inbox shows the AI icons next
  // to Send Email/Send SMS in the first place -- nothing is generated
  // until one of those icons is actually clicked.
  if (p0 === "/api/ai-agents/matches" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const contactId = url.searchParams.get("contactId");
    // contactMatchesTargeting only ever looks at status/programType --
    // callers that already have those two fields (the Inbox does, off the
    // conversation list's own SQLite-backed snapshot) can pass them
    // directly and skip a full CONTACTS_FILE read+find entirely. This ran
    // on every single conversation open (in parallel with the thread
    // fetch) and, at ~190MB/176k contacts, cost 1-1.5s+ on its own --
    // confirmed live as a real contributor to "opening a conversation
    // takes 3+ seconds" even after the sidebar's own query got fixed.
    // Falls back to the file read when the params aren't given, so any
    // other/future caller keeps working unchanged.
    const statusParam = url.searchParams.get("status");
    const programTypeParam = url.searchParams.get("programType");
    const contact = (statusParam !== null && programTypeParam !== null)
      ? { status: statusParam, programType: programTypeParam }
      : readJson(CONTACTS_FILE, []).find((c) => c.id === contactId);
    if (!contact) return sendJson(res, 200, { match: false });
    const agents = readJson(AI_AGENTS_FILE, []);
    const match = agents.some((a) => a.aiAssist && contactMatchesTargeting(contact, a.targeting));
    return sendJson(res, 200, { match });
  }

  // The actual generate/regenerate call behind each AI icon. Every check
  // in whyNotToGenerate() runs first (free); the model is only ever called
  // once a human has explicitly clicked to ask for a draft.
  if (p0 === "/api/ai-agents/generate" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const { contactId, channel } = await readJsonBody(req);
    if (!contactId || !["email", "sms"].includes(channel)) return sendJson(res, 400, { error: "contactId and channel ('email'|'sms') are required" });
    const contact = readJson(CONTACTS_FILE, []).find((c) => c.id === contactId);
    if (!contact) return sendJson(res, 404, { error: "Contact not found" });
    const agents = readJson(AI_AGENTS_FILE, []);
    const agent = agents.find((a) => a.aiAssist && contactMatchesTargeting(contact, a.targeting));
    if (!agent) return sendJson(res, 404, { error: "No AI Assist agent is configured for this lead" });

    const journey = getContactMessages(contactId).filter((m) => CONVERSATION_CHANNELS.includes(m.channel)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const skipReason = whyNotToGenerate(contact, journey);
    if (skipReason) return sendJson(res, 200, { status: "skip", reason: skipReason });

    const { promptText } = buildPromptForState(journey);
    const channelInstruction = channel === "email"
      ? "\n\n(Format your reply -- unless it's a [[NO_RESPONSE_NEEDED]] / [[ESCALATE]] marker -- as exactly:\nSUBJECT: <subject line>\nBODY:\n<email body>)"
      : "\n\n(This is a text message -- keep it to just the SMS text, unless it's a [[NO_RESPONSE_NEEDED]] / [[ESCALATE]] marker.)";

    try {
      const senderName = `${me.first || ""} ${me.last || ""}`.trim() || me.email;
      const result = await generateAgentReply(agent, contactId, promptText + channelInstruction, { senderName });
      if (result.skip) { logGeneration({ contactId, agentId: agent.id, channel, outcome: "skip", reason: result.reason }); return sendJson(res, 200, { status: "skip", reason: result.reason }); }
      if (result.escalate) { logGeneration({ contactId, agentId: agent.id, channel, outcome: "escalate", reason: result.escalate }); return sendJson(res, 200, { status: "escalate", reason: result.escalate }); }
      let subject = null, body = result.text;
      if (channel === "email") {
        const m = result.text.match(/^SUBJECT:\s*(.*)\n+BODY:\s*([\s\S]*)$/i);
        if (m) { subject = m[1].trim(); body = m[2].trim(); }
      }
      logGeneration({ contactId, agentId: agent.id, channel, outcome: "generated", buyingSignal: !!result.buyingSignal });
      return sendJson(res, 200, { status: "ok", subject, body, buyingSignal: !!result.buyingSignal, agentName: agent.name });
    } catch (err) {
      console.error(`[ai-assist-generate] agent ${agent.id} contact ${contactId} failed:`, err.message);
      return sendJson(res, 500, { error: "Generation failed" });
    }
  }

  // Short structured summary for the Inbox's "Summary" tab -- goal,
  // objections, and a recommendation, plus the same buying-signal/takeover
  // flag as a normal draft. Read-only -- never affects TERMINAL_STATUSES
  // or the recency gate, since a summary is useful even when a reply isn't.
  if (p0 === "/api/ai-agents/summarize" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const { contactId } = await readJsonBody(req);
    if (!contactId) return sendJson(res, 400, { error: "contactId is required" });
    const contact = readJson(CONTACTS_FILE, []).find((c) => c.id === contactId);
    if (!contact) return sendJson(res, 404, { error: "Contact not found" });
    const agents = readJson(AI_AGENTS_FILE, []);
    const agent = agents.find((a) => a.aiAssist && contactMatchesTargeting(contact, a.targeting));
    if (!agent) return sendJson(res, 404, { error: "No AI Assist agent is configured for this lead" });

    const journey = getContactMessages(contactId).filter((m) => CONVERSATION_CHANNELS.includes(m.channel));
    if (!journey.length) return sendJson(res, 200, { status: "ok", goal: null, objections: null, recommendation: "No conversation history yet.", takeover: false });

    const summaryInstruction = `Based on this lead's full history, respond in EXACTLY this format (plain text, no markdown, no extra commentary):
GOAL: <their stated or apparent goal, or "unclear" if not stated>
OBJECTIONS: <any objections raised so far, or "none raised">
RECOMMENDATION: <one sentence on what the closer should do next>
TAKEOVER: <yes or no> - <short reason>`;
    try {
      const journeyBlock = formatCustomerJourney(contact, getContactMessages(contactId));
      const systemPrompt = buildAgentSystemPrompt(agent, journeyBlock);
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 400, system: systemPrompt, messages: [{ role: "user", content: summaryInstruction }] }),
      });
      if (!anthropicRes.ok) throw new Error(`Anthropic error ${anthropicRes.status}: ${await anthropicRes.text()}`);
      const data = await anthropicRes.json();
      const raw = (data.content || []).find((b) => b.type === "text")?.text || "";
      const goal = raw.match(/GOAL:\s*(.*)/i)?.[1]?.trim() || null;
      const objections = raw.match(/OBJECTIONS:\s*(.*)/i)?.[1]?.trim() || null;
      const recommendation = raw.match(/RECOMMENDATION:\s*(.*)/i)?.[1]?.trim() || null;
      const takeoverMatch = raw.match(/TAKEOVER:\s*(yes|no)\s*-?\s*(.*)/i);
      const takeover = takeoverMatch ? /yes/i.test(takeoverMatch[1]) : false;
      const takeoverReason = takeoverMatch?.[2]?.trim() || null;
      return sendJson(res, 200, { status: "ok", goal, objections, recommendation, takeover, takeoverReason });
    } catch (err) {
      console.error(`[ai-assist-summarize] agent ${agent.id} contact ${contactId} failed:`, err.message);
      return sendJson(res, 500, { error: "Summary failed" });
    }
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
      const senderName = `${me.first || ""} ${me.last || ""}`.trim() || me.email;
      const systemPrompt = buildAgentSystemPrompt(agent, journeyBlock, false, senderName) + grounding;

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
  // The seed prompt new agents are created with -- editable independent of
  // any single agent record. Does not affect already-created agents.
  if (p === "/api/ai-agents/default-prompt" && req.method === "GET") {
    return sendJson(res, 200, { defaultSystemPrompt: getDefaultSystemPrompt() });
  }
  if (p === "/api/ai-agents/default-prompt" && req.method === "PATCH") {
    const { defaultSystemPrompt } = await readJsonBody(req);
    if (typeof defaultSystemPrompt !== "string" || !defaultSystemPrompt.trim()) {
      return sendJson(res, 400, { error: "defaultSystemPrompt is required" });
    }
    writeJson(AI_SETTINGS_FILE, { ...readJson(AI_SETTINGS_FILE, {}), defaultSystemPrompt });
    return sendJson(res, 200, { ok: true, defaultSystemPrompt });
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
      for (const k of ["name", "description", "systemPrompt", "active", "aiAssist", "targeting", "activeConfig"]) {
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
