import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, SEGMENTS_FILE, matchesSegment } from "./segments_shared.js";
import { getContactMessages } from "./message_index.js";
import {
  AI_AGENTS_FILE, TERMINAL_STATUSES, CONVERSATION_CHANNELS,
  generateAgentReply, contactMatchesTargeting,
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

const MAX_FOLLOWUPS = 3;

function isExcludable(contact) {
  if (contact.emailOptOut && contact.smsOptOut) return "opted out";
  if (!contact.email && !contact.phone) return "no email or phone on file";
  if (contact.status && TERMINAL_STATUSES.has(contact.status)) return `status is "${contact.status}"`;
  return null;
}

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

function randomDelayMs(minHours, maxHours) {
  const lo = Number(minHours) || 4, hi = Math.max(lo, Number(maxHours) || 24);
  return (lo + Math.random() * (hi - lo)) * 60 * 60 * 1000;
}

async function sendViaChannel(contact, channel, text, agentId) {
  if (channel === "email" && contact.email) {
    const { sendEmail } = await import("./email_backend.js");
    return sendEmail({
      to: contact.email, subject: "PacificRimAthletics.com",
      blocks: [{ id: "b1", type: "text", html: text.replace(/\n/g, "<br/>") }], theme: {}, footerTemplateId: null,
      contactId: contact.id, sourceType: "ai_active", sourceId: agentId,
    });
  }
  if (channel === "sms" && contact.phone) {
    const { sendSms } = await import("./sms_backend.js");
    return sendSms({ to: contact.phone, body: text, contactId: contact.id, sourceType: "ai_active", sourceId: agentId });
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
// nextActionAt before doing any real work, never scans the full contact
// list or message log).
export async function processAiActiveBatches() {
  const batches = readJson(AI_ACTIVE_BATCHES_FILE, []).filter((b) => b.status === "running");
  if (!batches.length) return;
  const agents = readJson(AI_AGENTS_FILE, []);
  const states = readJson(AI_ACTIVE_STATES_FILE, []);
  const contacts = readJson(CONTACTS_FILE, []);
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const now = Date.now();
  let changed = false;

  for (const batch of batches) {
    const agent = agents.find((a) => a.id === batch.agentId);
    // The agent's own Active toggle is the master kill-switch -- flipping
    // it off stops every batch it owns from taking any further action,
    // same as pausing each one individually.
    if (!agent || !agent.active) continue;
    const cfg = agent.activeConfig || {};
    const minH = cfg.waitTimeRange?.minHours ?? 4, maxH = cfg.waitTimeRange?.maxHours ?? 24;

    const due = states.filter((s) => s.batchId === batch.id && ["queued", "waiting_reply"].includes(s.state) && (!s.nextActionAt || new Date(s.nextActionAt).getTime() <= now));
    for (const st of due) {
      const contact = contactById.get(st.contactId);
      if (!contact) { st.state = "done"; st.updatedAt = new Date().toISOString(); changed = true; continue; }

      const exclReason = isExcludable(contact);
      if (exclReason) { st.state = contact.status && TERMINAL_STATUSES.has(contact.status) ? "done" : "opted_out"; st.updatedAt = new Date().toISOString(); changed = true; continue; }

      const journey = getContactMessages(contact.id).filter((m) => CONVERSATION_CHANNELS.includes(m.channel)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const lastMsg = journey.length ? journey.at(-1) : null;

      // Human takeover -- a real person (not this engine, not the AI
      // Assist icons, both of which go through the normal compose Send
      // and land here as sourceType "inbox") sent this contact something
      // more recently than our own last autonomous action. Stop for good.
      const lastHumanOutbound = [...journey].reverse().find((m) => m.direction === "outbound" && m.sourceType && m.sourceType !== "ai_active");
      if (lastHumanOutbound && (!st.lastActionAt || new Date(lastHumanOutbound.createdAt).getTime() > new Date(st.lastActionAt).getTime())) {
        st.state = "human_takeover"; st.updatedAt = new Date().toISOString(); changed = true; continue;
      }

      try {
        if (st.state === "queued") {
          const result = await generateAgentReply(agent, contact.id, "(This is a cold outreach opener to a new lead. Reference something specific from their real info/application if available. Keep it short and get them talking.)", { autoSend: true });
          if (!result.skip && !result.escalate && result.text) {
            const channel = contact.email ? "email" : "sms";
            await sendViaChannel(contact, channel, result.text, agent.id);
            st.state = "waiting_reply";
            st.lastActionAt = new Date().toISOString();
            st.nextActionAt = new Date(now + randomDelayMs(minH, maxH)).toISOString();
          } else {
            st.state = "done"; // nothing sendable (e.g. model judged no-go)
          }
        } else if (st.state === "waiting_reply") {
          const hasNewInbound = lastMsg && lastMsg.direction === "inbound" && (!st.lastSeenInboundAt || new Date(lastMsg.createdAt).getTime() > new Date(st.lastSeenInboundAt).getTime());
          if (hasNewInbound) {
            st.lastSeenInboundAt = lastMsg.createdAt;
            const result = await generateAgentReply(agent, contact.id, lastMsg.body || lastMsg.bodyPreview || "", { autoSend: true });
            const channel = lastMsg.channel === "sms" ? "sms" : "email";
            if (result.skip) {
              st.nextActionAt = new Date(now + randomDelayMs(minH, maxH)).toISOString();
            } else if (result.escalate) {
              st.state = "escalated";
            } else if (result.text) {
              await sendViaChannel(contact, channel, result.text, agent.id);
              st.lastActionAt = new Date().toISOString();
              if (result.buyingSignal) st.state = "hot_handoff";
              else st.nextActionAt = new Date(now + randomDelayMs(minH, maxH)).toISOString();
            }
          } else {
            // No reply yet -- a varied-timing follow-up, capped so this
            // never turns into indefinite nagging.
            if ((st.followUpCount || 0) >= MAX_FOLLOWUPS) { st.state = "done"; }
            else {
              const channel = contact.email ? "email" : "sms";
              const result = await generateAgentReply(agent, contact.id, "(The lead hasn't replied yet. Send a brief, genuinely different follow-up -- don't repeat earlier wording.)", { autoSend: true });
              if (!result.skip && !result.escalate && result.text) {
                await sendViaChannel(contact, channel, result.text, agent.id);
                st.followUpCount = (st.followUpCount || 0) + 1;
                st.lastActionAt = new Date().toISOString();
                st.nextActionAt = new Date(now + randomDelayMs(minH, maxH)).toISOString();
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
