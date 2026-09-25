import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, USERS_FILE } from "./auth_backend.js";
import { CONTACTS_FILE, SEGMENTS_FILE, matchesSegment } from "./segments_shared.js";
import { getContactMessages } from "./message_index.js";
import { getContactByIdFast } from "./sqlite_inbox.js";
import { getPublicBaseUrl } from "./integrations_backend.js";
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
// segments is an array now (was a single segment) -- a contact counts if
// it matches ANY of them (OR across segments' own filters), so a batch can
// target the union of several audiences (e.g. an existing applicant
// segment PLUS a "new leads since <date>, ongoing" segment) in one Start
// instead of needing one batch per segment.
function buildCandidateList(segments, batchSize, targeting) {
  const contacts = readJson(CONTACTS_FILE, []);
  const matching = contacts.filter((c) => segments.some((s) => matchesSegment(c, s.filter)) && contactMatchesTargeting(c, targeting));
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
export function randomDelayMs(waitTimeRange) {
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
// A cold-open hits every enabled, available channel for this contact
// (SMS AND email, not one or the other) -- "reach them at every point of
// contact we have" for the very first touch, rather than picking a single
// winner. forceChannel (test-send only) narrows that down to exactly one
// channel to check on demand, without touching the agent's own config.
async function generateColdOpenForChannel(agent, contact, cfg, channel) {
  const reengage = cfg.reengagement || {};
  const customPrompt = reengage[channel]?.prompt?.trim();
  const defaultPrompt = channel === "email"
    ? "This is a cold re-engagement opener to a lead via email -- write a short, warm, personal-sounding opener referencing something specific from their real info/application if available, and inviting a reply."
    : "This is a cold re-engagement opener to a lead via SMS -- keep it very short and text-native, reference something specific from their real info/application if available, and ask one specific question to get them talking.";
  let promptText = `(${customPrompt || defaultPrompt} Write this fully in the voice/tone already defined above for this agent -- don't fall back to a generic marketing-copywriting structure or tone that isn't consistent with it.)`;
  if (channel === "email") promptText += "\n\n(Format your reply -- unless it's a [[NO_RESPONSE_NEEDED]] / [[ESCALATE]] marker -- as exactly:\nSUBJECT: <subject line>\nBODY:\n<email body>)";
  const result = await generateAgentReply(agent, contact.id, promptText, { autoSend: true, senderName: agent.name });
  if (result.skip || result.escalate || !result.text) return { ok: false, reason: result.skip ? "Model judged no-go (skip)." : result.escalate ? "Model escalated instead of drafting a cold-open." : "No text produced." };
  let subject = null, body = result.text;
  if (channel === "email") {
    const m = result.text.match(/^SUBJECT:\s*(.*)\n+BODY:\s*([\s\S]*)$/i);
    if (m) { subject = m[1].trim(); body = m[2].trim(); }
  }
  return { ok: true, channel, subject, body };
}
export async function generateColdOpen(agent, contact, cfg, forceChannel = null) {
  const reengage = cfg.reengagement || {};
  const smsOk = reengage.sms?.enabled && !!contact.phone;
  const emailOk = reengage.email?.enabled && !!contact.email;
  if (!smsOk && !emailOk) return { sendable: false, reason: "Neither Re-engagement SMS nor Email is enabled (or the contact has no phone/email for the enabled channel)." };
  if (forceChannel === "sms" && !smsOk) return { sendable: false, reason: "SMS re-engagement isn't enabled, or this contact has no phone number." };
  if (forceChannel === "email" && !emailOk) return { sendable: false, reason: "Email re-engagement isn't enabled, or this contact has no email address." };
  const channels = forceChannel ? [forceChannel] : [smsOk && "sms", emailOk && "email"].filter(Boolean);
  const openers = [];
  const reasons = [];
  for (const channel of channels) {
    const r = await generateColdOpenForChannel(agent, contact, cfg, channel);
    if (r.ok) openers.push({ channel: r.channel, subject: r.subject, body: r.body });
    else reasons.push(`${channel}: ${r.reason}`);
  }
  if (!openers.length) return { sendable: false, reason: reasons.join("; ") || "No text produced." };
  return { sendable: true, openers };
}

// cfg.emailSenderId (Batches & Targeting's "Send emails as" field) picks a
// real connected team-user identity for this agent's OWN emails -- reuses
// the exact same sendViaGmail path a human's Inbox reply goes through, so
// the From header/signature is genuinely that person's Gmail, not a
// generic shared address. Falls back to the org default sender (the old
// behavior, unchanged) when unset or when that user hasn't connected
// Gmail -- an agent with no sender picked isn't broken, it just sends the
// way it always has.
// Every email after the very first one in a real conversation should land
// as a REPLY inside that same Gmail thread, not as its own new top-level
// email -- confirmed live: a lead got a wall of separate unthreaded emails
// instead of one growing conversation. Finds the most recent prior email
// that actually passed through THIS mailbox (matched by address, not just
// "any email this contact has ever gotten" -- an old campaign or a
// different sender's email lives in a different mailbox/thread entirely)
// and threads against it. Returns null for a genuine first contact --
// nothing to reply to yet.
function findEmailThreadContext(contact, mailboxEmail) {
  const addr = (mailboxEmail || "").toLowerCase();
  if (!addr) return null;
  const prior = getContactMessages(contact.id)
    .filter((m) => m.channel === "email" && ((m.to || "").toLowerCase().includes(addr) || (m.from || "").toLowerCase().includes(addr)))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return prior || null;
}
function replySubject(priorSubject) {
  const s = (priorSubject || "PacificRimAthletics.com").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
// A short plain sign-off for an in-thread reply, instead of repeating the
// FULL footer template (photo, marketing copy, physical address, its own
// unsubscribe line) on every single back-and-forth -- confirmed live that
// doing so made Gmail auto-collapse the repeated block, and reads nothing
// like how a real person actually emails back and forth. Keeps a minimal,
// always-required unsubscribe link (not the surrounding marketing copy)
// rather than dropping compliance entirely.
function replySignoffHtml(senderFirstName, contactId) {
  const name = (senderFirstName || "").trim();
  const unsubscribeUrl = `${getPublicBaseUrl()}/api/email/unsubscribe?c=${encodeURIComponent(contactId || "")}`;
  return `<div style="margin-top:16px">Coach ${name || "Kai"}</div>
    <div style="margin-top:10px;font-size:11px;color:#888"><a href="${unsubscribeUrl}" style="color:#888">Unsubscribe</a></div>`;
}
export async function sendViaChannel(contact, channel, text, agentId, subject, sourceType = "ai_active", senderId = null) {
  if (channel === "email" && contact.email) {
    const { text: cleaned, gifUrl } = extractGifMarker(text);
    const gifHtml = gifUrl ? `<div><img src="${gifUrl}" alt="" style="max-width:320px"/></div>` : "";
    const sender = senderId ? readJson(USERS_FILE, []).find((u) => u.id === senderId && u.gmailRefreshToken) : null;
    if (sender) {
      const { sendViaGmail } = await import("./gmail_backend.js");
      // subject is only ever passed explicitly for the cold-open (see
      // generateColdOpen) -- every other call (a reply/follow-up) passes
      // undefined and relies entirely on threading to land in the right
      // place, so a prior thread's own subject (with Re:) always wins over
      // the generic fallback once one exists.
      const prior = findEmailThreadContext(contact, sender.gmailEmail);
      // References should carry the WHOLE chain (RFC-correct, and more
      // robust for a recipient client's own threading than In-Reply-To
      // alone) -- prior's own References plus prior's own real Message-ID,
      // not just the single immediate parent.
      const references = prior ? [prior.references, prior.messageIdHeader].filter(Boolean).join(" ") || undefined : undefined;
      const signoff = prior ? replySignoffHtml(sender.first, contact.id) : "";
      const blocks = [{ id: "b1", type: "text", html: cleaned.replace(/\n/g, "<br/>") + gifHtml + signoff }];
      return sendViaGmail({
        user: sender, to: contact.email,
        subject: prior ? replySubject(prior.subject) : (subject || "PacificRimAthletics.com"),
        blocks, theme: {},
        contactId: contact.id, sourceType, sourceId: agentId, footerTemplateId: sender.footerTemplateId || null,
        skipFooter: !!prior,
        threadId: prior?.threadId, inReplyTo: prior?.messageIdHeader, references,
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
    // The cold-open prompt asks for a "SUBJECT: .../BODY: ..." format on
    // email only, but the model sometimes echoes that same shape into an SMS
    // reply anyway -- confirmed live: a real SMS send went out reading
    // "subject: quick follow up on your application" as its own first line.
    // Text has no subject line at all, so strip it defensively rather than
    // texting it to the lead.
    const smsText = text.replace(/^\s*subject:\s*.*\n+(?:body:\s*)?/i, "");
    // A reply can be split into two short back-to-back texts instead of
    // one long one (see the per-agent MESSAGE FORMAT prompt rule) --
    // [[SPLIT]] is the model's own signal for that boundary. Sent as two
    // separate Twilio messages a couple seconds apart, so it reads as
    // someone texting twice in a row rather than one message with a line
    // break in it.
    const parts = smsText.split("[[SPLIT]]").map((p) => p.trim()).filter(Boolean);
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
    // segmentIds (array) is current; segmentId (single) still accepted so
    // an older saved agent config (or a stale client) keeps working.
    const { agentId, segmentId, segmentIds, batchSize } = await readJsonBody(req);
    const ids = Array.isArray(segmentIds) && segmentIds.length ? segmentIds : (segmentId ? [segmentId] : []);
    const agent = readJson(AI_AGENTS_FILE, []).find((a) => a.id === agentId);
    const allSegments = readJson(SEGMENTS_FILE, []);
    const segments = ids.map((id) => allSegments.find((s) => s.id === id)).filter(Boolean);
    if (!segments.length) return sendJson(res, 404, { error: "Segment not found" });
    const size = Math.max(1, Math.min(1000, Number(batchSize) || 25));
    const result = buildCandidateList(segments, size, agent?.targeting);
    return sendJson(res, 200, {
      totalMatchingSegment: result.totalMatching,
      willContact: result.candidates.map((c) => ({ id: c.id, name: `${c.first} ${c.last}`.trim(), email: c.email, phone: c.phone, status: c.status })),
      excludedCount: result.excludedCount,
      excludedSample: result.excluded.slice(0, 10),
      remainingAfterCap: result.remainingAfterCap,
    });
  }

  if (p === "/api/ai-active/start" && req.method === "POST") {
    const { agentId, segmentId, segmentIds, batchSize, confirmOver100 } = await readJsonBody(req);
    const ids = Array.isArray(segmentIds) && segmentIds.length ? segmentIds : (segmentId ? [segmentId] : []);
    const agent = readJson(AI_AGENTS_FILE, []).find((a) => a.id === agentId);
    if (!agent) return sendJson(res, 404, { error: "Agent not found" });
    const allSegments = readJson(SEGMENTS_FILE, []);
    const segments = ids.map((id) => allSegments.find((s) => s.id === id)).filter(Boolean);
    if (!segments.length) return sendJson(res, 404, { error: "Segment not found" });
    const size = Math.max(1, Math.min(1000, Number(batchSize) || 25));
    const result = buildCandidateList(segments, size, agent.targeting);
    if (!result.candidates.length) return sendJson(res, 400, { error: "No contacts left to message after exclusions" });
    if (result.candidates.length > 100 && !confirmOver100) {
      return sendJson(res, 200, { needsConfirmation: true, count: result.candidates.length });
    }
    const batches = readJson(AI_ACTIVE_BATCHES_FILE, []);
    const batch = {
      id: randomUUID(), agentId, segmentIds: ids, segmentNames: segments.map((s) => s.name), batchSize: size,
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
// Most recent message of ONE specific channel in an already-sorted (oldest
// first) journey -- SMS and email are tracked as fully independent
// sub-conversations below (see the waiting_reply rewrite's own comment for
// why), so "what's the latest thing on THIS channel" has to be asked
// separately from "what's the latest thing overall".
function latestOnChannel(journey, channel) {
  for (let i = journey.length - 1; i >= 0; i--) if (journey[i].channel === channel) return journey[i];
  return null;
}
// A full-array overwrite of a shared JSON file is risky here -- one
// processAiActiveBatches tick can run for a while (many awaited model calls
// across many contacts) between its own initial read and its final write,
// during which a real HTTP request (Fresh Start deleting a batch/state, a
// new test-send creating one) can genuinely change the file on disk.
// Overwriting with a stale in-memory snapshot would silently resurrect a
// row someone just deleted, or erase one someone just added -- confirmed
// live: a Fresh Start's own delete got reverted this way, leaving an
// orphaned "waiting_reply" state with no real batch behind it, which then
// blocked a later real cold-open from ever getting tracked at all. Re-reads
// fresh right before writing and merges: this tick's own tracked updates
// win for rows it touched, everything else defers to whatever's actually
// on disk right now.
function mergeSafeWrite(file, ours) {
  const fresh = readJson(file, []);
  const oursById = new Map(ours.map((r) => [r.id, r]));
  const merged = fresh.map((f) => oursById.get(f.id) || f);
  writeJson(file, merged);
}
export async function processAiActiveBatches() {
  const allBatches = readJson(AI_ACTIVE_BATCHES_FILE, []);
  if (!allBatches.length) return;
  const agents = readJson(AI_AGENTS_FILE, []);
  const states = readJson(AI_ACTIVE_STATES_FILE, []);
  const now = Date.now();
  let changed = false;

  // A lead who used up their follow-ups without ever replying (state
  // "done") isn't a dead end forever -- if they reply for real later on,
  // Kai should pick the conversation back up instead of leaving a genuine
  // reply permanently unanswered. Confirmed live: a real reply sent well
  // after the last follow-up went completely unanswered because "done"
  // (and a batch that auto-completed once nothing was left active) were
  // never reconsidered by anything below. Skipped for a batch the user
  // explicitly paused -- that's a deliberate "stop touching this", same as
  // everywhere else -- but a batch that merely auto-completed is exactly
  // the case this exists to undo.
  const reactivatedBatchIds = new Set();
  for (const st of states) {
    if (st.state !== "done") continue;
    const batch = allBatches.find((b) => b.id === st.batchId);
    if (!batch || batch.status === "paused") continue;
    const contact = getContactByIdFast(st.contactId);
    if (!contact) continue;
    const journey = getContactMessages(contact.id).filter((m) => CONVERSATION_CHANNELS.includes(m.channel)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    // lastSeenInboundAt is per-channel (see waiting_reply below) -- a
    // channel this conversation never touched, or a pre-migration state
    // whose lastSeenInboundAt was still the old single-timestamp shape,
    // both just read as "nothing seen on this channel yet", which is the
    // correct, safe default either way.
    const seen = (st.lastSeenInboundAt && typeof st.lastSeenInboundAt === "object") ? st.lastSeenInboundAt : {};
    const reactivateChannel = ["sms", "email"].find((channel) => {
      const last = latestOnChannel(journey, channel);
      return last && last.direction === "inbound" && (!seen[channel] || new Date(last.createdAt).getTime() > new Date(seen[channel]).getTime());
    });
    if (reactivateChannel) {
      st.state = "waiting_reply";
      st.followUpCount = {};
      st.nextActionAt = new Date(now).toISOString();
      st.updatedAt = new Date().toISOString();
      changed = true;
      if (batch.status === "completed") reactivatedBatchIds.add(batch.id);
    }
  }
  if (reactivatedBatchIds.size) {
    const reactivated = [];
    for (const b of allBatches) if (reactivatedBatchIds.has(b.id)) { b.status = "running"; reactivated.push(b); }
    mergeSafeWrite(AI_ACTIVE_BATCHES_FILE, reactivated);
  }

  const batches = allBatches.filter((b) => b.status === "running");
  if (!batches.length) {
    if (changed) mergeSafeWrite(AI_ACTIVE_STATES_FILE, states);
    return;
  }

  const touchedStates = []; // every state actually processed this tick -- what the final merge-safe write below persists
  for (const batch of batches) {
    const agent = agents.find((a) => a.id === batch.agentId);
    if (!agent) continue;
    // The agent's own Active toggle is the master kill-switch for REAL
    // campaigns -- flipping it off stops every real batch it owns from
    // taking any further action, same as pausing each one individually. A
    // test-send-tracked batch (isTestBatch) is a single contact the user
    // explicitly, directly told to send a real message to (behind its own
    // confirm() dialog) -- confirmed live: turning that into "also flip the
    // agent live" just to get a real reply answered during testing isn't
    // what a one-off test should require, so it runs regardless of the
    // agent's own Active state.
    if (!agent.active && !batch.isTestBatch) continue;
    const cfg = agent.activeConfig || {};
    // A test-send-tracked contact (see ai_agents_backend.js's /test-send)
    // gets its own real single-contact batch so real replies actually get
    // real automatic follow-ups -- but its ongoing sends still need to stay
    // out of real Activity/reporting counts, same reasoning as the initial
    // one-off send itself.
    const sourceType = batch.isTestBatch ? "ai_active_test" : "ai_active";

    const due = states.filter((s) => s.batchId === batch.id && ["queued", "waiting_reply"].includes(s.state) && (!s.nextActionAt || new Date(s.nextActionAt).getTime() <= now));
    touchedStates.push(...due);
    for (const st of due) {
      const contact = getContactByIdFast(st.contactId);
      if (!contact) { st.state = "done"; st.updatedAt = new Date().toISOString(); changed = true; continue; }

      const exclReason = isExcludable(contact);
      if (exclReason) { st.state = contact.status && TERMINAL_STATUSES.has(contact.status) ? "done" : "opted_out"; st.updatedAt = new Date().toISOString(); changed = true; continue; }

      const journey = getContactMessages(contact.id).filter((m) => CONVERSATION_CHANNELS.includes(m.channel)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

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
        const lastHumanOutbound = [...journey].reverse().find((m) => m.direction === "outbound" && m.sourceType && m.sourceType !== "ai_active" && m.sourceType !== "ai_active_test");
        if (lastHumanOutbound && st.lastActionAt && new Date(lastHumanOutbound.createdAt).getTime() > new Date(st.lastActionAt).getTime()) {
          st.state = "human_takeover"; st.updatedAt = new Date().toISOString(); changed = true; continue;
        }
      }

      try {
        if (st.state === "queued") {
          const opener = await generateColdOpen(agent, contact, cfg);
          if (opener.sendable) {
            // Hits every enabled/available channel for the first touch (see
            // generateColdOpen) -- send each opener in turn rather than just
            // the first.
            for (const o of opener.openers) {
              await sendViaChannel(contact, o.channel, o.body, agent.id, o.subject, sourceType, cfg.emailSenderId);
            }
            st.state = "waiting_reply";
            st.lastActionAt = new Date().toISOString();
            st.nextActionAt = new Date(now + randomDelayMs(cfg.waitTimeRange)).toISOString();
          } else {
            st.state = "done"; // nothing sendable (e.g. neither channel enabled, or model judged no-go)
          }
        } else if (st.state === "waiting_reply") {
          // SMS and email are tracked as fully independent sub-conversations
          // here -- confirmed live, three real bugs from treating them as
          // one shared cursor: (1) a reply could go out on whichever channel
          // happened to have the chronologically-latest message overall,
          // answering an SMS with an email or an email with a text; (2) the
          // no-reply follow-up branch hardcoded "email if the contact has
          // one, else sms", so an active SMS conversation with an email
          // address on file got silently abandoned in favor of emailing
          // instead; (3) once the shared cursor advanced past an inbound on
          // one channel (because a LATER message arrived on the other
          // channel), that first channel's message could never trigger its
          // own reply. Each channel below only ever reacts to and replies on
          // ITS OWN messages.
          if (typeof st.lastSeenInboundAt !== "object" || !st.lastSeenInboundAt) st.lastSeenInboundAt = {};
          if (typeof st.followUpCount !== "object" || !st.followUpCount) st.followUpCount = {};
          const maxFollowUps = Number.isFinite(cfg.maxFollowUps) ? cfg.maxFollowUps : MAX_FOLLOWUPS;
          let anyChannelStillActive = false;
          const nextTimes = [];
          for (const channel of ["sms", "email"]) {
            if (st.state !== "waiting_reply") break; // escalated/hot_handoff from the other channel this same tick
            const chJourney = journey.filter((m) => m.channel === channel);
            if (!chJourney.length) continue; // Kai has never touched this channel with this contact
            const lastChMsg = chJourney.at(-1);
            const seenAt = st.lastSeenInboundAt[channel];
            const hasNewInbound = lastChMsg.direction === "inbound" && (!seenAt || new Date(lastChMsg.createdAt).getTime() > new Date(seenAt).getTime());
            if (hasNewInbound && (now - new Date(lastChMsg.createdAt).getTime()) < messageBufferMs(cfg)) {
              // Still inside the settle buffer -- catches a second rapid-fire
              // message on THIS channel before generating anything.
              // Deliberately does NOT touch lastSeenInboundAt -- still
              // "pending a reply", not "no reply yet".
              anyChannelStillActive = true;
              nextTimes.push(new Date(lastChMsg.createdAt).getTime() + messageBufferMs(cfg));
              continue;
            }
            if (hasNewInbound) {
              st.lastSeenInboundAt[channel] = lastChMsg.createdAt;
              const result = await generateAgentReply(agent, contact.id, lastChMsg.body || lastChMsg.bodyPreview || "", { autoSend: true, senderName: agent.name });
              if (result.skip) {
                anyChannelStillActive = true;
                nextTimes.push(now + randomDelayMs(cfg.waitTimeRange));
              } else if (result.escalate) {
                st.state = "escalated";
              } else if (result.text) {
                await sendViaChannel(contact, channel, result.text, agent.id, undefined, sourceType, cfg.emailSenderId);
                st.lastActionAt = new Date().toISOString();
                if (result.buyingSignal) { st.state = "hot_handoff"; }
                else {
                  st.followUpCount[channel] = 0; // fresh reply resets this channel's own follow-up cadence
                  anyChannelStillActive = true;
                  nextTimes.push(now + randomDelayMs(cfg.waitTimeRange));
                }
              }
              continue;
            }
            // No reply yet on this channel -- a varied-timing follow-up,
            // capped independently per channel (maxFollowUps/
            // followUpWaitTimeRange, falling back to waitTimeRange/
            // MAX_FOLLOWUPS) so one channel exhausting its follow-ups never
            // stops the other from still following up on its own cadence.
            if ((st.followUpCount[channel] || 0) >= maxFollowUps) continue; // this channel is done; the other may not be
            const result = await generateAgentReply(agent, contact.id, "(The lead hasn't replied yet. Send a brief follow-up that continues the SAME thing you just asked -- a different angle on it, not a generic \"still there?\" check-in and not a new topic. Example: if you asked what's held them back, a follow-up could offer a couple concrete options, e.g. \"is it more like X, or is it more recent than that?\")", { autoSend: true, senderName: agent.name });
            if (!result.skip && !result.escalate && result.text) {
              await sendViaChannel(contact, channel, result.text, agent.id, undefined, sourceType, cfg.emailSenderId);
              st.followUpCount[channel] = (st.followUpCount[channel] || 0) + 1;
              st.lastActionAt = new Date().toISOString();
              anyChannelStillActive = true;
              nextTimes.push(now + randomDelayMs(cfg.followUpWaitTimeRange || cfg.waitTimeRange));
            }
          }
          if (st.state === "waiting_reply") {
            st.state = anyChannelStillActive ? "waiting_reply" : "done";
            if (anyChannelStillActive) st.nextActionAt = new Date(Math.min(...nextTimes)).toISOString();
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
  if (changed) mergeSafeWrite(AI_ACTIVE_STATES_FILE, touchedStates);
}
