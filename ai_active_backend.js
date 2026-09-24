import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, USERS_FILE } from "./auth_backend.js";
import { CONTACTS_FILE, SEGMENTS_FILE, matchesSegment } from "./segments_shared.js";
import { getContactMessages } from "./message_index.js";
import { getContactByIdFast } from "./sqlite_inbox.js";
import {
  AI_AGENTS_FILE, TERMINAL_STATUSES, CONVERSATION_CHANNELS,
  generateAgentReply, contactMatchesTargeting, isExcludable,
} from "./ai_agents_backend.js";

// ── AI Active -- "works the selected lead batch and brings the human in
// when needed", the counterpart to AI Assist ("helps the human work
// conversations"). Reuses the SAME agent record (agent.active is the
// on/off switch, agent.activeConfig holds segment/batch-size/wait-time
// settings) and the SAME generateAgentReply/playbook grounding as AI
// Assist -- the only real difference is that this sends automatically,
// with no per-message human review.
//
// Everything here is deliberately conservative about blast radius:
// - A batch is a FROZEN list of contactIds captured once at start time,
//   never "the segment re-evaluated live" -- so it can never silently
//   grow to the whole database just because more contacts later match
//   the segment's filter.
// - /preview never sends anything or creates any record -- it's pure
//   read, so a closer can see exactly who's about to be contacted.
// - Starting a batch over 100 leads requires an explicit second
//   confirmation (confirmOver100), matching "review every conversation
//   before expanding beyond 100 leads."
// - Every send re-checks opt-out/terminal-status live at send time (not
//   just at preview time), and stops permanently the moment a human
//   sends this contact anything themselves.
export const AI_ACTIVE_BATCHES_FILE = "crm_ai_active_batches.json";
export const AI_ACTIVE_STATES_FILE = "crm_ai_active_states.json";

const MAX_FOLLOWUPS = 3; // fallback default when an agent has no cfg.maxFollowUps set

// Applies a segment's filter AND the agent's own lead-type/status targeting
// (the same targeting AI Assist uses to decide which contacts get icons --
// it's not AI-Assist-only, it narrows AI Active's batch too), then the
// exclusions above, then caps to batchSize -- the exact same logic /preview
// shows and /start freezes, so what you approved in preview is what
// actually gets contacted.
function buildCandidateList(segment, batchSize, targeting) {
  const contacts = readJson(CONTACTS_FILE, []);
  const matching = contacts.filter((c) => matchesSegment(c, segment.filter) && contactMatchesTargeting(c, targeting));
  const excluded = [];
  const candidates = [];
  for (const c of matching) {
    const reason = isExcludable(c);
    if (reason) excluded.push({ id: c.id, name: `${c.first} ${c.last}`.trim(), reason });
    else candidates.push(c);
  }
  const capped = candidates.slice(0, batchSize);
  return { totalMatching: matching.length, excluded, candidates: capped, excludedCount: excluded.length, remainingAfterCap: Math.max(0, candidates.length - capped.length) };
}

// minUnit/maxUnit are independent ("seconds"|"minutes"|"hours"|"days") --
// min and max can be in different units (e.g. "30 seconds to 2 hours").
// Falls back to a shared `unit`, then to "hours", for records saved
// before per-field units existed (those only ever stored minHours/maxHours,
// always meaning hours).
export const WAIT_UNIT_MS = { seconds: 1000, minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
// Fixed (not randomized) settle window -- how long to wait after the
// LATEST inbound message before treating it as settled and worth replying
// to. Exists so two texts sent back to back get answered once, together,
// instead of each independently triggering its own reply (confirmed live
// this was happening). 90s default if an agent's never set its own.
const DEFAULT_MESSAGE_BUFFER_MS = 90 * 1000;
function messageBufferMs(cfg) {
  const b = cfg.messageBuffer;
  if (!b || b.value == null || b.value === "") return DEFAULT_MESSAGE_BUFFER_MS;
  return (Number(b.value) || 0) * (WAIT_UNIT_MS[b.unit] || WAIT_UNIT_MS.seconds);
}
function randomDelayMs(waitTimeRange) {
  const range = waitTimeRange || {};
  const minMult = WAIT_UNIT_MS[range.minUnit || range.unit] || WAIT_UNIT_MS.hours;
  const maxMult = WAIT_UNIT_MS[range.maxUnit || range.unit] || WAIT_UNIT_MS.hours;
  const loMs = (Number(range.min ?? range.minHours) || 4) * minMult;
  const hiMs = Math.max(loMs, (Number(range.max ?? range.maxHours) || 24) * maxMult);
  return loMs + Math.random() * (hiMs - loMs);
}

// sourceType defaults to "ai_active" (this file's own callers) but is
// overridable so behavioral_triggers_backend.js can reuse the exact same
// send path while tagging its messages distinctly (its own frequency-cap
// and revisit logic key off sourceType === "behavioral_trigger").
// A GIF (or any image) an agent's OWN prompt catalog points it at -- see
// the per-agent "GIFS AVAILABLE" prompt section -- signaled the same way
// [[SPLIT]] is, via [[GIF: <url>]] on its own line. Nothing about which
// gif/when is hardcoded here; that's entirely the prompt's own editable
// catalog and usage rule. Extracts the url and returns the text with the
// marker removed.
function extractGifMarker(text) {
  const m = text.match(/\[\[GIF:\s*(\S+?)\s*\]\]/i);
  if (!m) return { text, gifUrl: null };
  return { text: text.replace(m[0], "").trim(), gifUrl: m[1] };
}

// Shared by processAiActiveBatches' own "queued" branch and the
// agent-editor's one-off real test-send (POST /api/ai-agents/:id/test-send
// below) -- same cold-open generation either way, so a real test-send
// proves exactly what the real batch engine would actually say/do,
// instead of a second, potentially-drifting copy of this logic.
export async function generateColdOpen(agent, contact, cfg) {
  const reengage = cfg.reengagement || {};
  const smsOk = reengage.sms?.enabled && !!contact.phone;
  const emailOk = reengage.email?.enabled && !!contact.email;
  if (!smsOk && !emailOk) return { sendable: false, reason: "Neither Re-engagement SMS nor Email is enabled (or the contact has no phone/email for the enabled channel)." };
  const channel = emailOk ? "email" : "sms"; // prefer email when both are enabled and available
  const customPrompt = reengage[channel]?.prompt?.trim();
  const defaultPrompt = channel === "email"
    ? "This is a cold re-engagement opener to a lead via email -- write a short, warm, personal-sounding opener referencing something specific from their real info/application if available, and inviting a reply."
    : "This is a cold re-engagement opener to a lead via SMS -- keep it very short and text-native, reference something specific from their real info/application if available, and ask one specific question to get them talking.";
  let promptText = `(${customPrompt || defaultPrompt} Write this fully in the voice/tone already defined above for this agent -- don't fall back to a generic marketing-copywriting structure or tone that isn't consistent with it.)`;
  if (channel === "email") promptText += "\n\n(Format your reply -- unless it's a [[NO_RESPONSE_NEEDED]] / [[ESCALATE]] marker -- as exactly:\nSUBJECT: <subject line>\nBODY:\n<email body>)";
  const result = await generateAgentReply(agent, contact.id, promptText, { autoSend: true, senderName: agent.name });
  if (result.skip || result.escalate || !result.text) return { sendable: false, reason: result.skip ? "Model judged no-go (skip)." : result.escalate ? "Model escalated instead of drafting a cold-open." : "No text produced." };
  let subject = null, body = result.text;
  if (channel === "email") {
    const m = result.text.match(/^SUBJECT:\s*(.*)\n+BODY:\s*([\s\S]*)$/i);
    if (m) { subject = m[1].trim(); body = m[2].trim(); }
  }
  return { sendable: true, channel, subject, body };
}

// cfg.emailSenderId (Batches & Targeting's "Send emails as" field) picks a
// real connected team-user identity for this agent's OWN emails -- reuses
// the exact same sendViaGmail path a human's Inbox reply goes through, so
// the From header/signature is genuinely that person's Gmail, not a
// generic shared address. Falls back to the org default sender (the old
// behavior, unchanged) when unset or when that user hasn't connected
// Gmail -- an agent with no sender picked isn't broken, it just sends the
// way it always has.
export async function sendViaChannel(contact, channel, text, agentId, subject, sourceType = "ai_active", senderId = null) {
  if (channel === "email" && contact.email) {
    const { text: cleaned, gifUrl } = extractGifMarker(text);
    const gifHtml = gifUrl ? `<div><img src="${gifUrl}" alt="" style="max-width:320px"/></div>` : "";
    const blocks = [{ id: "b1", type: "text", html: cleaned.replace(/\n/g, "<br/>") + gifHtml }];
    const sender = senderId ? readJson(USERS_FILE, []).find((u) => u.id === senderId && u.gmailRefreshToken) : null;
    if (sender) {
      const { sendViaGmail } = await import("./gmail_backend.js");
      return sendViaGmail({
        user: sender, to: contact.email, subject: subject || "PacificRimAthletics.com", blocks, theme: {},
        contactId: contact.id, sourceType, sourceId: agentId, footerTemplateId: sender.footerTemplateId || null,
      });
    }
    const { sendEmail } = await import("./email_backend.js");
    return sendEmail({
      to: contact.email, subject: subject || "PacificRimAthletics.com",
      blocks, theme: {}, footerTemplateId: null,
      contactId: contact.id, sourceType, sourceId: agentId,
    });
  }
  if (channel === "sms" && contact.phone) {
    const { sendSms } = await import("./sms_backend.js");
    // A reply can be split into two short back-to-back texts instead of
    // one long one (see the per-agent MESSAGE FORMAT prompt rule) --
    // [[SPLIT]] is the model's own signal for that boundary. Sent as two
    // separate Twilio messages a couple seconds apart, so it reads as
    // someone texting twice in a row rather than one message with a line
    // break in it.
    const parts = text.split("[[SPLIT]]").map((p) => p.trim()).filter(Boolean);
    let result = null;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2500));
      const { text: cleaned, gifUrl } = extractGifMarker(parts[i]);
      result = await sendSms({ to: contact.phone, body: cleaned, contactId: contact.id, sourceType, sourceId: agentId, mediaUrl: gifUrl || undefined });
    }
    return result;
  }
  return null;
}

function batchStats(batchId, states) {
  const rows = states.filter((s) => s.batchId === batchId);
  return {
    total: rows.length,
    sent: rows.filter((s) => s.lastActionAt).length,
    waitingReply: rows.filter((s) => s.state === "waiting_reply").length,
    hotHandoff: rows.filter((s) => s.state === "hot_handoff").length,
    escalated: rows.filter((s) => s.state === "escalated").length,
    humanTakeover: rows.filter((s) => s.state === "human_takeover").length,
    optedOut: rows.filter((s) => s.state === "opted_out").length,
    done: rows.filter((s) => s.state === "done").length,
  };
}

export async function handleAiActiveRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/ai-active")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/ai-active/preview" && req.method === "POST") {
    const { agentId, segmentId, batchSize } = await readJsonBody(req);
    const agent = readJson(AI_AGENTS_FILE, []).find((a) => a.id === agentId);
    const segment = readJson(SEGMENTS_FILE, []).find((s) => s.id === segmentId);
    if (!segment) return sendJson(res, 404, { error: "Segment not found" });
    const size = Math.max(1, Math.min(1000, Number(batchSize) || 25));
    const result = buildCandidateList(segment, size, agent?.targeting);
    return sendJson(res, 200, {
      totalMatchingSegment: result.totalMatching,
      willContact: result.candidates.map((c) => ({ id: c.id, name: `${c.first} ${c.last}`.trim(), email: c.email, phone: c.phone, status: c.status })),
      excludedCount: result.excludedCount,
      excludedSample: result.excluded.slice(0, 10),
      remainingAfterCap: result.remainingAfterCap,
    });
  }

  if (p === "/api/ai-active/start" && req.method === "POST") {
    const { agentId, segmentId, batchSize, confirmOver100 } = await readJsonBody(req);
    const agent = readJson(AI_AGENTS_FILE, []).find((a) => a.id === agentId);
    if (!agent) return sendJson(res, 404, { error: "Agent not found" });
    const segment = readJson(SEGMENTS_FILE, []).find((s) => s.id === segmentId);
    if (!segment) return sendJson(res, 404, { error: "Segment not found" });
    const size = Math.max(1, Math.min(1000, Number(batchSize) || 25));
    const result = buildCandidateList(segment, size, agent.targeting);
    if (!result.candidates.length) return sendJson(res, 400, { error: "No contacts left to message after exclusions" });
    if (result.candidates.length > 100 && !confirmOver100) {
      return sendJson(res, 200, { needsConfirmation: true, count: result.candidates.length });
    }
    const batches = readJson(AI_ACTIVE_BATCHES_FILE, []);
    const batch = {
      id: randomUUID(), agentId, segmentId, segmentName: segment.name, batchSize: size,
      contactIds: result.candidates.map((c) => c.id), // frozen -- never re-evaluated against the live segment
      excludedCount: result.excludedCount,
      status: "running",
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), createdBy: me.id,
    };
    batches.push(batch);
    writeJson(AI_ACTIVE_BATCHES_FILE, batches);
    const states = readJson(AI_ACTIVE_STATES_FILE, []);
    const now = new Date().toISOString();
    for (const c of result.candidates) {
      states.push({ id: randomUUID(), batchId: batch.id, agentId, contactId: c.id, state: "queued", followUpCount: 0, nextActionAt: now, createdAt: now, updatedAt: now });
    }
    writeJson(AI_ACTIVE_STATES_FILE, states);
    return sendJson(res, 200, { ok: true, batch });
  }

  if (p === "/api/ai-active" && req.method === "GET") {
    const batches = readJson(AI_ACTIVE_BATCHES_FILE, []);
    const states = readJson(AI_ACTIVE_STATES_FILE, []);
    return sendJson(res, 200, { batches: batches.map((b) => ({ ...b, stats: batchStats(b.id, states) })) });
  }

  const detailMatch = p.match(/^\/api\/ai-active\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const batches = readJson(AI_ACTIVE_BATCHES_FILE, []);
    const batch = batches.find((b) => b.id === detailMatch[1]);
    if (!batch) return sendJson(res, 404, { error: "Batch not found" });
    const states = readJson(AI_ACTIVE_STATES_FILE, []).filter((s) => s.batchId === batch.id);
    const contacts = readJson(CONTACTS_FILE, []);
    const rows = states.map((s) => {
      const c = contacts.find((x) => x.id === s.contactId);
      return { ...s, contactName: c ? `${c.first} ${c.last}`.trim() : "(deleted contact)", contactEmail: c?.email, contactPhone: c?.phone };
    });
    return sendJson(res, 200, { batch: { ...batch, stats: batchStats(batch.id, states) }, states: rows });
  }

  const pauseMatch = p.match(/^\/api\/ai-active\/([^/]+)\/pause$/);
  if (pauseMatch && req.method === "POST") {
    const batches = readJson(AI_ACTIVE_BATCHES_FILE, []);
    const batch = batches.find((b) => b.id === pauseMatch[1]);
    if (!batch) return sendJson(res, 404, { error: "Batch not found" });
    batch.status = "paused";
    batch.pausedAt = new Date().toISOString();
    writeJson(AI_ACTIVE_BATCHES_FILE, batches);
    return sendJson(res, 200, { ok: true });
  }
  const resumeMatch = p.match(/^\/api\/ai-active\/([^/]+)\/resume$/);
  if (resumeMatch && req.method === "POST") {
    const batches = readJson(AI_ACTIVE_BATCHES_FILE, []);
    const batch = batches.find((b) => b.id === resumeMatch[1]);
    if (!batch) return sendJson(res, 404, { error: "Batch not found" });
    batch.status = "running";
    batch.pausedAt = null;
    writeJson(AI_ACTIVE_BATCHES_FILE, batches);
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

// ── Scheduler-driven processing. Called every tick from scheduler.js;
// cheap when there's nothing due (filters small per-batch state files by
// nextActionAt before doing any real work). Contact lookups below are
// indexed single-contact reads (getContactByIdFast), not a full
// readJson(CONTACTS_FILE, []) -- this used to unconditionally load the
// entire ~190MB contacts file the moment any batch was "running" (which can
// span hours per campaign), confirmed live as a direct cause of multi-
// second stalls on unrelated concurrent requests.
export async function processAiActiveBatches() {
  const batches = readJson(AI_ACTIVE_BATCHES_FILE, []).filter((b) => b.status === "running");
  if (!batches.length) return;
  const agents = readJson(AI_AGENTS_FILE, []);
  const states = readJson(AI_ACTIVE_STATES_FILE, []);
  const now = Date.now();
  let changed = false;

  for (const batch of batches) {
    const agent = agents.find((a) => a.id === batch.agentId);
    // The agent's own Active toggle is the master kill-switch -- flipping
    // it off stops every batch it owns from taking any further action,
    // same as pausing each one individually.
    if (!agent || !agent.active) continue;
    const cfg = agent.activeConfig || {};

    const due = states.filter((s) => s.batchId === batch.id && ["queued", "waiting_reply"].includes(s.state) && (!s.nextActionAt || new Date(s.nextActionAt).getTime() <= now));
    for (const st of due) {
      const contact = getContactByIdFast(st.contactId);
      if (!contact) { st.state = "done"; st.updatedAt = new Date().toISOString(); changed = true; continue; }

      const exclReason = isExcludable(contact);
      if (exclReason) { st.state = contact.status && TERMINAL_STATUSES.has(contact.status) ? "done" : "opted_out"; st.updatedAt = new Date().toISOString(); changed = true; continue; }

      const journey = getContactMessages(contact.id).filter((m) => CONVERSATION_CHANNELS.includes(m.channel)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const lastMsg = journey.length ? journey.at(-1) : null;

      // Human takeover -- a real person (not this engine, not the AI
      // Assist icons, both of which go through the normal compose Send
      // and land here as sourceType "inbox") sent this contact something
      // MORE RECENTLY THAN Kai's own last action here. Only meaningful
      // once Kai has actually made contact (st.lastActionAt is set) --
      // for a still-"queued" lead who's never been messaged by this batch
      // yet, `!st.lastActionAt` used to short-circuit this to true for
      // ANY non-ai_active outbound in the contact's ENTIRE history (a
      // years-old marketing campaign or sequence send, unrelated to
      // anyone actively working this lead now), which falsely marked
      // every fresh cold-open as "human_takeover" before Kai ever sent
      // anything -- confirmed live: a batch of 9 came back 0 sent, 9
      // human_takeover. Old campaign history has no bearing on whether
      // AI Active should send its own first message.
      if (st.state === "waiting_reply") {
        const lastHumanOutbound = [...journey].reverse().find((m) => m.direction === "outbound" && m.sourceType && m.sourceType !== "ai_active");
        if (lastHumanOutbound && st.lastActionAt && new Date(lastHumanOutbound.createdAt).getTime() > new Date(st.lastActionAt).getTime()) {
          st.state = "human_takeover"; st.updatedAt = new Date().toISOString(); changed = true; continue;
        }
      }

      try {
        if (st.state === "queued") {
          const opener = await generateColdOpen(agent, contact, cfg);
          if (opener.sendable) {
            await sendViaChannel(contact, opener.channel, opener.body, agent.id, opener.subject, "ai_active", cfg.emailSenderId);
            st.state = "waiting_reply";
            st.lastActionAt = new Date().toISOString();
            st.nextActionAt = new Date(now + randomDelayMs(cfg.waitTimeRange)).toISOString();
          } else {
            st.state = "done"; // nothing sendable (e.g. neither channel enabled, or model judged no-go)
          }
        } else if (st.state === "waiting_reply") {
          const hasNewInbound = lastMsg && lastMsg.direction === "inbound" && (!st.lastSeenInboundAt || new Date(lastMsg.createdAt).getTime() > new Date(st.lastSeenInboundAt).getTime());
          if (hasNewInbound && (now - new Date(lastMsg.createdAt).getTime()) < messageBufferMs(cfg)) {
            // Still inside the settle buffer -- catches a second rapid-fire
            // text before generating anything (confirmed live: two texts
            // sent back to back could otherwise each trigger their own
            // independent reply instead of one that addresses both).
            // Deliberately does NOT touch lastSeenInboundAt -- this inbound
            // is still "pending a reply", not "no reply yet", so the
            // no-new-inbound follow-up branch below can't misfire while
            // we're just waiting out the buffer. A newer inbound arriving
            // before this fires naturally re-anchors the buffer, since
            // lastMsg/its createdAt will have moved by the next check.
            st.nextActionAt = new Date(new Date(lastMsg.createdAt).getTime() + messageBufferMs(cfg)).toISOString();
          } else if (hasNewInbound) {
            st.lastSeenInboundAt = lastMsg.createdAt;
            const result = await generateAgentReply(agent, contact.id, lastMsg.body || lastMsg.bodyPreview || "", { autoSend: true, senderName: agent.name });
            const channel = lastMsg.channel === "sms" ? "sms" : "email";
            if (result.skip) {
              st.nextActionAt = new Date(now + randomDelayMs(cfg.waitTimeRange)).toISOString();
            } else if (result.escalate) {
              st.state = "escalated";
            } else if (result.text) {
              await sendViaChannel(contact, channel, result.text, agent.id, undefined, "ai_active", cfg.emailSenderId);
              st.lastActionAt = new Date().toISOString();
              if (result.buyingSignal) st.state = "hot_handoff";
              else st.nextActionAt = new Date(now + randomDelayMs(cfg.waitTimeRange)).toISOString();
            }
          } else {
            // No reply yet -- a varied-timing follow-up, capped so this
            // never turns into indefinite nagging. Both the cap and the
            // wait are agent-configurable (maxFollowUps/followUpWaitTimeRange)
            // and deliberately separate from waitTimeRange above -- a
            // fast-paced qualification agent wants a short, consistent
            // follow-up gap (e.g. a flat 4 minutes) that's nothing like its
            // own reply-to-inbound delay (e.g. a randomized 4-8 minutes).
            // Falls back to the shared waitTimeRange/MAX_FOLLOWUPS for any
            // agent that's never set the follow-up-specific fields.
            const maxFollowUps = Number.isFinite(cfg.maxFollowUps) ? cfg.maxFollowUps : MAX_FOLLOWUPS;
            if ((st.followUpCount || 0) >= maxFollowUps) { st.state = "done"; }
            else {
              const channel = contact.email ? "email" : "sms";
              const result = await generateAgentReply(agent, contact.id, "(The lead hasn't replied yet. Send a brief follow-up that continues the SAME thing you just asked -- a different angle on it, not a generic \"still there?\" check-in and not a new topic. Example: if you asked what's held them back, a follow-up could offer a couple concrete options, e.g. \"is it more like X, or is it more recent than that?\")", { autoSend: true, senderName: agent.name });
              if (!result.skip && !result.escalate && result.text) {
                await sendViaChannel(contact, channel, result.text, agent.id, undefined, "ai_active", cfg.emailSenderId);
                st.followUpCount = (st.followUpCount || 0) + 1;
                st.lastActionAt = new Date().toISOString();
                st.nextActionAt = new Date(now + randomDelayMs(cfg.followUpWaitTimeRange || cfg.waitTimeRange)).toISOString();
              } else {
                st.state = "done";
              }
            }
          }
        }
      } catch (err) {
        console.error(`[ai-active] batch ${batch.id} contact ${contact.id} failed:`, err.message);
      }
      st.updatedAt = new Date().toISOString();
      changed = true;
    }

    // Auto-complete a batch once nothing in it can still act.
    const stillActive = states.some((s) => s.batchId === batch.id && ["queued", "waiting_reply"].includes(s.state));
    if (!stillActive) {
      const batches2 = readJson(AI_ACTIVE_BATCHES_FILE, []);
      const b2 = batches2.find((b) => b.id === batch.id);
      if (b2 && b2.status === "running") { b2.status = "completed"; writeJson(AI_ACTIVE_BATCHES_FILE, batches2); }
    }
  }
  if (changed) writeJson(AI_ACTIVE_STATES_FILE, states);
}
