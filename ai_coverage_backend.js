import { readJson, USERS_FILE } from "./auth_backend.js";
import { getContactById } from "./contacts_db.js";
import { getContactMessages } from "./message_index.js";
import {
  AI_AGENTS_FILE, CONVERSATION_CHANNELS,
  generateAgentReply, isExcludable, findLastHumanOutbound, findUnansweredInbound, sentCategoryForSourceType, inboundMessageText,
} from "./ai_agents_backend.js";
import { sendViaChannel, findCoverageState, trackCoverageReply, wakeStatesForInbound } from "./ai_active_backend.js";

// ── AI Coverage -- the fourth autonomous mode: while a specific teammate
// is marked Away (Inbox's self-service toggle, gated by canUseAiActive in
// Settings), any agent whose targeting.coverForUserIds includes that
// teammate autonomously replies to NEW inbound messages from leads THAT
// TEAMMATE OWNS. Deliberately reactive only -- it never proactively
// cold-opens a covered lead's whole book the moment someone goes away
// (that would be AI Active's own batch feature, a separate deliberate
// action); it just answers what comes in while they're out, the way a
// human covering for a coworker would.
//
// coverForUserIds can also carry the synthetic id "unassigned" -- covers
// inbound replies from leads with NO owner at all, unconditionally (no
// "Away" gate, since there's no human on that lead to begin with).
//
// Stateless by design: unlike AI Active's batches/states or the
// behavioral-trigger queue, there's no persisted per-contact record here
// at all. Eligibility (is the owner away, is there an agent covering for
// them, has a human already jumped back in) is recomputed fresh from the
// contact's own message journey every time a new inbound message arrives,
// the same "derive from the log, don't duplicate state" approach already
// used for AI Active's human-takeover check.
export const SOURCE_TYPE = "ai_coverage";

function findCoveringAgent(agents, ownerId) {
  return agents.find((a) => a.active && (a.targeting?.coverForUserIds || []).includes(ownerId));
}

// Called right after logMessage() for a real inbound SMS/email reply --
// see sms_backend.js's Twilio webhook and gmail_backend.js's
// processGmailMessage. Fire-and-forget from the caller's point of view
// (awaited, but never expected to throw out to it -- errors are caught
// and logged here so a coverage failure never breaks the actual inbound-
// message-logging path it's hooked onto).
export async function maybeCoverInboundReply(contactId) {
  // Every inbound SMS/email lands here (sms_backend / gmail_backend), so
  // this is where a tracked conversation -- coverage's or AI Active's --
  // gets pulled forward to be answered on the engine's next tick.
  try { wakeStatesForInbound(contactId); } catch (e) { console.error("[ai-coverage] wakeStatesForInbound failed:", e.message); }
  try {
    const contact = getContactById(contactId);
    if (!contact) return;

    const agents = readJson(AI_AGENTS_FILE, []);
    let agent, owner, introLine;
    if (contact.ownerId) {
      owner = readJson(USERS_FILE, []).find((u) => u.id === contact.ownerId);
      if (!owner || !owner.away || !owner.canUseAiActive) return;
      agent = findCoveringAgent(agents, contact.ownerId);
      if (!agent) return;
      introLine = `(You're covering for ${owner.first} ${owner.last}, who owns this lead and is currently marked Away. Respond to what they just said below, using the full context of this relationship.)`;
    } else {
      // No owner at all -- "unassigned" is a synthetic id in the same
      // coverForUserIds list (see ai-agent-editor.html's Coverage
      // checklist), covered unconditionally rather than gated on anyone
      // being marked Away -- there's no owner to go Away in the first
      // place, so there's nobody normally on this lead to begin with.
      agent = findCoveringAgent(agents, "unassigned");
      if (!agent) return;
      introLine = `(This lead has no assigned owner. Respond to what they just said below, using the full context of this relationship.)`;
    }

    if (isExcludable(contact)) return;

    // Once this lead's conversation is tracked for follow-ups (see
    // ai_active_backend.js's trackCoverageReply), the batch engine owns
    // every later reply AND the no-reply follow-ups -- it answers a new
    // inbound on its next tick (plus the agent's own waitTimeRange), and
    // its own lastSeenInboundAt cursor is what prevents a double answer.
    // Replying here as well would be exactly that double answer. A state
    // that's "done" (follow-ups used up) is still the engine's: its
    // reactivation pass picks a genuinely new inbound back up itself.
    // Anything else (escalated, hot_handoff, human_takeover, opted_out) is
    // the engine standing down, so this instant path handles the reply the
    // way it always has, and trackCoverageReply below re-arms the state.
    const tracked = findCoverageState(agent.id, contactId);
    if (tracked && ["queued", "waiting_reply", "done"].includes(tracked.state)) return;

    const journey = getContactMessages(contactId).filter((m) => CONVERSATION_CHANNELS.includes(m.channel)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    // Their latest message nobody has actually answered -- a campaign/
    // automation/sequence blast landing after it doesn't count as an answer.
    const lastMsg = findUnansweredInbound(journey);
    if (!lastMsg) return;

    // Human takeover -- if the owner (back early, replying from their
    // phone) or anyone else has personally messaged this lead more
    // recently than the agent itself did (in ANY mode -- coverage, AI
    // Active, test send), stand down. Used to compare against coverage
    // sends only, so a teammate's email from weeks earlier blocked coverage
    // forever even when the lead was replying to Kai's own AI Active email.
    const lastAgentSend = [...journey].reverse().find((m) => m.direction === "outbound" && (sentCategoryForSourceType(m.sourceType) === "ai_agent" || m.sourceType === "ai_active_test"));
    const lastHumanOutbound = findLastHumanOutbound(journey);
    if (lastHumanOutbound && (!lastAgentSend || new Date(lastHumanOutbound.createdAt).getTime() > new Date(lastAgentSend.createdAt).getTime())) return;

    // Just the lead's literal latest message, not the whole journey
    // re-rendered into the user turn -- matches ai_active_backend.js's own
    // pattern (its inbound-reply call passes only lastInbound.body/
    // bodyPreview). Confirmed live (2026-10-05): this used to duplicate the
    // ENTIRE conversation history into the user turn on top of what
    // generateAgentReply ALREADY builds into the system prompt (its own
    // journeyBlock/grounding), and a real reply that skipped straight to
    // booking instead of following the system prompt's own objective
    // sequence came out of exactly this path. The system prompt (same for
    // every autonomous mode) already carries full conversation context;
    // the user turn only needs to be the one thing to actually respond to.
    // Plain text, quoted copy of our own email cut off (inboundMessageText)
    // -- this used to hand the model the raw inbound HTML.
    const promptText = introLine + "\n\n" + inboundMessageText(lastMsg);
    const channel = lastMsg.channel === "sms" ? "sms" : "email";
    const channelInstruction = channel === "email"
      ? "\n\n(Format your reply -- unless it's a [[NO_RESPONSE_NEEDED]] / [[ESCALATE]] marker -- as exactly:\nSUBJECT: <subject line>\nBODY:\n<email body>)"
      : "";
    const result = await generateAgentReply(agent, contactId, promptText + channelInstruction, { autoSend: true, senderName: agent.name });
    if (result.skip || result.escalate || !result.text) return;

    let subject = null, body = result.text;
    if (channel === "email") {
      const m = result.text.match(/^SUBJECT:\s*(.*)\n+BODY:\s*([\s\S]*)$/i);
      if (m) { subject = m[1].trim(); body = m[2].trim(); }
    }
    const sent = await sendViaChannel(contact, channel, body, agent.id, subject, SOURCE_TYPE, agent.activeConfig?.emailSenderId);
    if (sent && sent.ok === false) return; // nothing went out -- nothing to follow up on
    trackCoverageReply(agent, contactId, channel, lastMsg.createdAt, { close: !!result.close });
  } catch (err) {
    console.error(`[ai-coverage] contact ${contactId} failed:`, err.message);
  }
}
