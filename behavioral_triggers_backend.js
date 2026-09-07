import { randomUUID } from "crypto";
import { readJson, writeJson, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, matchesSegment, SEGMENTS_FILE } from "./segments_shared.js";
import { getContactMessages } from "./message_index.js";
import {
  AI_AGENTS_FILE, CONVERSATION_CHANNELS,
  generateAgentReply, contactMatchesTargeting, formatCustomerJourney, isExcludable,
} from "./ai_agents_backend.js";
import { sendViaChannel, WAIT_UNIT_MS } from "./ai_active_backend.js";

// ── Behavioral triggers -- "reach out because of what a lead just did,"
// the third mode alongside AI Assist (human-reviewed drafts) and AI Active
// (works a frozen batch). This one is event-driven: a page visit, an email
// open/click, or an SMS-link click (detected via the existing `el=sms-`
// query tag on a normal page visit -- no separate SMS click infrastructure
// exists or is needed) queues a contextual outbound, sent after a short
// randomized wait so it feels like a real person noticed, not an instant
// bot reply. Reuses AI Active's generateAgentReply/sendViaChannel and the
// same conservative philosophy: never fires for terminal/opted-out
// contacts, always identifies as the agent (not "Alexis"), and a
// per-contact frequency cap + revisit-follow-up rule keep this from
// spamming someone who just happens to browse the site a lot in one day.
export const BEHAVIOR_TRIGGERS_FILE = "crm_behavior_triggers.json";
const SOURCE_TYPE = "behavioral_trigger";

function randomWaitMs(range) {
  const r = range || {};
  const minMult = WAIT_UNIT_MS[r.minUnit || r.unit] || WAIT_UNIT_MS.seconds;
  const maxMult = WAIT_UNIT_MS[r.maxUnit || r.unit] || WAIT_UNIT_MS.seconds;
  const loMs = (Number(r.min) || 60) * minMult;
  const hiMs = Math.max(loMs, (Number(r.max) || 300) * maxMult);
  return loMs + Math.random() * (hiMs - loMs);
}

// A page-visit's raw query string doubles as context for two signals that
// have no dedicated tracking of their own: `el=sms-<slug>` (an SMS-sent
// link, tagged at send time by appendSourceTagToSmsBody) means this visit
// IS an SMS click, and `yt=<video-id>` (a convention for video links you
// tag yourself when sending -- no YouTube API integration exists or is
// needed for this) means this visit followed watching/clicking a specific
// video. Both ride on the exact same page-visit event; no new tracking.
function parseVisitContext(search) {
  const s = String(search || "");
  const elMatch = s.match(/(?:^|[?&])el=([^&]*)/);
  const ytMatch = s.match(/(?:^|[?&])yt=([^&]*)/);
  const el = elMatch ? decodeURIComponent(elMatch[1]) : null;
  return {
    isSmsClick: !!el && el.startsWith("sms-"),
    smsSlug: el && el.startsWith("sms-") ? el.slice(4) : null,
    videoId: ytMatch ? decodeURIComponent(ytMatch[1]) : null,
  };
}

function findEligibleAgents(contact) {
  const agents = readJson(AI_AGENTS_FILE, []);
  const segments = readJson(SEGMENTS_FILE, []);
  return agents.filter((a) => {
    const bt = a.activeConfig?.behavioralTrigger;
    if (!a.active || !bt?.enabled) return false;
    if (!contactMatchesTargeting(contact, a.targeting)) return false;
    if (bt.segmentId) {
      const segment = segments.find((s) => s.id === bt.segmentId);
      if (!segment || !matchesSegment(contact, segment.filter)) return false;
    }
    return true;
  });
}

function recentBehavioralSends(contactId, agentId, sinceMs) {
  const journey = getContactMessages(contactId).filter((m) => CONVERSATION_CHANNELS.includes(m.channel));
  return journey.filter((m) => m.direction === "outbound" && m.sourceType === SOURCE_TYPE && m.sourceId === agentId && new Date(m.createdAt).getTime() >= sinceMs);
}

function lastBehavioralSend(contactId, agentId) {
  const journey = getContactMessages(contactId).filter((m) => CONVERSATION_CHANNELS.includes(m.channel));
  const sends = journey.filter((m) => m.direction === "outbound" && m.sourceType === SOURCE_TYPE && m.sourceId === agentId);
  return sends.length ? sends.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b)) : null;
}

// Called from the real-time hook points (page visit, SES open/click
// webhook) and from the AC engagement poll. Cheap and synchronous except
// for the final writeJson -- never calls the model here, only decides
// whether/when a later scheduler tick should.
export function queueBehavioralTrigger({ contactId, source, context }) {
  if (!contactId || !source) return;
  const contacts = readJson(CONTACTS_FILE, []);
  const contact = contacts.find((c) => c.id === contactId);
  if (!contact) return;
  if (isExcludable(contact)) return;

  const agents = findEligibleAgents(contact).filter((a) => a.activeConfig.behavioralTrigger.sources?.[source]);
  if (!agents.length) return;

  const triggers = readJson(BEHAVIOR_TRIGGERS_FILE, []);
  const now = Date.now();
  let changed = false;

  for (const agent of agents) {
    const bt = agent.activeConfig.behavioralTrigger;

    // Frequency cap -- count actual sends (not queued attempts) within the
    // configured rolling window; a lead browsing 10 pages in an afternoon
    // should not generate 10 outbounds.
    const windowMs = (Number(bt.frequencyCap?.windowValue) || 24) * (WAIT_UNIT_MS[bt.frequencyCap?.windowUnit] || WAIT_UNIT_MS.hours);
    const capCount = Number(bt.frequencyCap?.maxCount) || 1;
    if (recentBehavioralSends(contactId, agent.id, now - windowMs).length >= capCount) continue;

    const existingPending = triggers.find((t) => t.contactId === contactId && t.agentId === agent.id && t.status === "pending");
    const last = lastBehavioralSend(contactId, agent.id);

    if (existingPending) {
      // They did something else before the first message even went out --
      // refresh context/timer to the latest activity rather than firing
      // once per event. Keeps this from spamming a fast browsing session.
      existingPending.source = source;
      existingPending.context = context || {};
      existingPending.dueAt = new Date(now + randomWaitMs(bt.waitThreshold)).toISOString();
      existingPending.updatedAt = new Date().toISOString();
      changed = true;
      continue;
    }

    // Already reached out once via this mechanism, and they came back --
    // honor the "give it a day" rule instead of messaging again right away.
    // Otherwise (first-ever trigger for this contact+agent, or a revisit
    // with no revisit-follow-up rule configured) it's just the normal
    // randomized wait threshold.
    const dueAt = last && bt.revisitFollowUp?.enabled
      ? new Date(now + (Number(bt.revisitFollowUp.delayValue) || 1) * (WAIT_UNIT_MS[bt.revisitFollowUp.delayUnit] || WAIT_UNIT_MS.days)).toISOString()
      : new Date(now + randomWaitMs(bt.waitThreshold)).toISOString();

    triggers.push({
      id: randomUUID(), agentId: agent.id, contactId, source, context: context || {},
      status: "pending", dueAt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    changed = true;
  }

  if (changed) writeJson(BEHAVIOR_TRIGGERS_FILE, triggers);
}

function describeSource(trigger) {
  const c = trigger.context || {};
  if (trigger.source === "page_visit") return `visited ${c.path || "a page on the site"}`;
  if (trigger.source === "sms_click") return `clicked a link you texted them${c.smsSlug ? ` (${c.smsSlug})` : ""}`;
  if (trigger.source === "video_watch") return `clicked through to a video${c.videoId ? ` (id: ${c.videoId})` : ""}`;
  if (trigger.source === "email_open") return "opened an email from you";
  if (trigger.source === "email_click") return "clicked a link in an email from you";
  return "engaged with something recently";
}

export async function processBehavioralTriggers() {
  const triggers = readJson(BEHAVIOR_TRIGGERS_FILE, []);
  const due = triggers.filter((t) => t.status === "pending" && new Date(t.dueAt).getTime() <= Date.now());
  if (!due.length) return;

  const agents = readJson(AI_AGENTS_FILE, []);
  const contacts = readJson(CONTACTS_FILE, []);
  let changed = false;

  for (const trigger of due) {
    const agent = agents.find((a) => a.id === trigger.agentId);
    const contact = contacts.find((c) => c.id === trigger.contactId);
    if (!agent || !agent.active || !contact) { trigger.status = "cancelled"; trigger.updatedAt = new Date().toISOString(); changed = true; continue; }
    const exclReason = isExcludable(contact);
    if (exclReason) { trigger.status = "opted_out"; trigger.updatedAt = new Date().toISOString(); changed = true; continue; }

    // Re-check the frequency cap at send time too, not just at queue time
    // -- another trigger for this contact could have fired and sent in
    // the meantime.
    const bt = agent.activeConfig?.behavioralTrigger || {};
    const windowMs = (Number(bt.frequencyCap?.windowValue) || 24) * (WAIT_UNIT_MS[bt.frequencyCap?.windowUnit] || WAIT_UNIT_MS.hours);
    const capCount = Number(bt.frequencyCap?.maxCount) || 1;
    if (recentBehavioralSends(contact.id, agent.id, Date.now() - windowMs).length >= capCount) {
      trigger.status = "skipped"; trigger.updatedAt = new Date().toISOString(); changed = true; continue;
    }

    // Human takeover -- someone already personally on this lead takes
    // priority over an automated behavioral nudge.
    const journey = getContactMessages(contact.id).filter((m) => CONVERSATION_CHANNELS.includes(m.channel)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const lastHumanOutbound = [...journey].reverse().find((m) => m.direction === "outbound" && m.sourceType && m.sourceType !== SOURCE_TYPE && m.sourceType !== "ai_active");
    if (lastHumanOutbound && new Date(lastHumanOutbound.createdAt).getTime() > new Date(trigger.createdAt).getTime()) {
      trigger.status = "cancelled"; trigger.updatedAt = new Date().toISOString(); changed = true; continue;
    }

    try {
      const journeyBlock = formatCustomerJourney(contact, journey);
      const daysSinceFirstSeen = contact.firstSeenAt ? Math.round((Date.now() - new Date(contact.firstSeenAt).getTime()) / (24 * 60 * 60 * 1000)) : null;
      const promptText = `(This is a real-time behavioral trigger, not a normal reply -- the lead just ${describeSource(trigger)}.
${daysSinceFirstSeen != null ? `They've been a lead for about ${daysSinceFirstSeen} day(s).` : ""}
${contact.visitedPaths?.length ? `Pages they've visited over time: ${contact.visitedPaths.join(", ")}.` : ""}
Write a short, specific, contextual outbound message referencing what they just did and their real history/application below -- NOT a generic "just checking in." Get them talking about why they haven't moved forward, or acknowledge what they were looking at. Keep it very short and casual for SMS, or short and warm for email.)${journeyBlock}`;

      const channel = contact.email ? "email" : "sms";
      const channelInstruction = channel === "email"
        ? "\n\n(Format your reply -- unless it's a [[NO_RESPONSE_NEEDED]] / [[ESCALATE]] marker -- as exactly:\nSUBJECT: <subject line>\nBODY:\n<email body>)"
        : "";
      const result = await generateAgentReply(agent, contact.id, promptText + channelInstruction, { autoSend: true, senderName: agent.name });

      if (result.skip) { trigger.status = "skipped"; trigger.skipReason = result.reason; }
      else if (result.escalate) { trigger.status = "escalated"; }
      else if (result.text) {
        let subject = null, body = result.text;
        if (channel === "email") {
          const m = result.text.match(/^SUBJECT:\s*(.*)\n+BODY:\s*([\s\S]*)$/i);
          if (m) { subject = m[1].trim(); body = m[2].trim(); }
        }
        await sendViaChannel(contact, channel, body, agent.id, subject, SOURCE_TYPE);
        trigger.status = "sent";
      } else {
        trigger.status = "skipped";
      }
    } catch (err) {
      console.error(`[behavioral-triggers] trigger ${trigger.id} contact ${trigger.contactId} failed:`, err.message);
      trigger.status = "failed";
    }
    trigger.updatedAt = new Date().toISOString();
    changed = true;
  }

  if (changed) writeJson(BEHAVIOR_TRIGGERS_FILE, triggers);
}

export { parseVisitContext };

// Read-only visibility for the AI Agents panel -- most recent triggers
// (any status), newest first, optionally filtered to one agent, plus a
// quick status breakdown so "is this actually doing anything" has an
// answer without digging through the raw file.
export async function handleBehavioralTriggersRequest(req, res, url) {
  if (url.pathname !== "/api/behavioral-triggers" || req.method !== "GET") return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });
  const agentId = url.searchParams.get("agentId");
  const triggers = readJson(BEHAVIOR_TRIGGERS_FILE, []).filter((t) => !agentId || t.agentId === agentId);
  const contacts = readJson(CONTACTS_FILE, []);
  const byStatus = {};
  for (const t of triggers) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const recent = [...triggers]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .slice(0, 50)
    .map((t) => {
      const c = contacts.find((x) => x.id === t.contactId);
      return { ...t, contactName: c ? `${c.first} ${c.last}`.trim() : "(deleted contact)" };
    });
  return sendJson(res, 200, { total: triggers.length, byStatus, recent });
}
