import { readJson, USERS_FILE } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { getContactMessages } from "./message_index.js";
import {
  AI_AGENTS_FILE, CONVERSATION_CHANNELS,
  generateAgentReply, formatCustomerJourney, isExcludable,
} from "./ai_agents_backend.js";
import { sendViaChannel } from "./ai_active_backend.js";

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
  try {
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find((c) => c.id === contactId);
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

    const journey = getContactMessages(contactId).filter((m) => CONVERSATION_CHANNELS.includes(m.channel)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const lastMsg = journey.length ? journey.at(-1) : null;
    if (!lastMsg || lastMsg.direction !== "inbound") return; // sanity -- this should always be the message that was just logged

    // Human takeover -- if the owner (back early, replying from their
    // phone) or anyone else has personally messaged this lead more
    // recently than this engine's own last covering reply, stand down.
    const lastCoverageSend = [...journey].reverse().find((m) => m.direction === "outbound" && m.sourceType === SOURCE_TYPE);
    const lastHumanOutbound = [...journey].reverse().find((m) => m.direction === "outbound" && m.sourceType && !["ai_active", "ai_coverage", "behavioral_trigger"].includes(m.sourceType));
    if (lastHumanOutbound && (!lastCoverageSend || new Date(lastHumanOutbound.createdAt).getTime() > new Date(lastCoverageSend.createdAt).getTime())) return;

    const journeyBlock = formatCustomerJourney(contact, journey);
    const promptText = introLine + journeyBlock;
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
    await sendViaChannel(contact, channel, body, agent.id, subject, SOURCE_TYPE, agent.activeConfig?.emailSenderId);
  } catch (err) {
    console.error(`[ai-coverage] contact ${contactId} failed:`, err.message);
  }
}
