// Merges ActiveCampaign's own real per-recipient send/open/click data into
// the CRM -- the ONLY source of truth for engagement right now: AWS SES
// is sandboxed (see gmail_backend.js's GMAIL_SCOPE comment) and Gmail-sent
// correspondence carries no tracking at all, but AC is the live send path
// for campaigns/automations and DOES have real engagement data, it's just
// never made it into this CRM's own message log before.
//
// One-directional import chain (ac_sync -> import_backend), deliberately
// its own file rather than adding this to import_backend.js itself --
// import_backend.js already imports FROM inbox_backend.js (CALLS_FILE
// etc.), so a function here that inbox_backend.js needs to call would
// otherwise create a genuine A<->B cycle between those two files instead
// of a clean line.
import { readJson } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { logMessage, PROVIDER_ID_INDEX_FILE } from "./message_log.js";
import { acConfigured, fetchAcOneToOneCampaigns, fetchAcContactActivities, acCampaignName } from "./import_backend.js";
import { getRecentlyActiveContactIds } from "./sqlite_inbox.js";

// fetchAcOneToOneCampaigns is a full paginated account sweep (see its own
// comment) -- fine once, wasteful to repeat on every single contact-open.
let oneToOneCache = null, oneToOneCacheAt = 0;
const ONE_TO_ONE_TTL_MS = 5 * 60 * 1000;
async function getOneToOneCampaigns() {
  if (oneToOneCache && Date.now() - oneToOneCacheAt < ONE_TO_ONE_TTL_MS) return oneToOneCache;
  oneToOneCache = await fetchAcOneToOneCampaigns();
  oneToOneCacheAt = Date.now();
  return oneToOneCache;
}

// Fired (fire-and-forget) whenever a conversation is opened -- see
// gmail_backend.js's reconcileRecentGmailForContact for the identical
// reasoning: checking on demand for whichever contact someone's actually
// looking at, instead of iterating AC's per-contact activity feed (one
// real API call each) across the ~160K contacts linked to AC on some
// blind schedule.
export async function syncAcEngagementForContact(contactId) {
  if (!acConfigured() || !contactId) return;
  const contact = readJson(CONTACTS_FILE, []).find(c => c.id === contactId);
  const acContactId = contact?.externalIds?.acContactId;
  if (!acContactId || !contact.email) return;
  const email = contact.email.toLowerCase();

  // 1:1 personalized/automation-triggered sends -- single recipient, so
  // AC's own aggregate open/click counts on the campaign ARE this
  // contact's real per-message status, not an approximation. sdate
  // stands in for sent/opened/clicked time alike -- AC's aggregate stats
  // carry no more precise timestamp than the send itself.
  const oneToOne = await getOneToOneCampaigns();
  for (const c of oneToOne.filter(x => x.email === email)) {
    const pid = `ac_1to1:${c.id}`;
    if (readJson(PROVIDER_ID_INDEX_FILE, {})[pid]) continue;
    logMessage({
      channel: "email", direction: "outbound", contactId,
      sourceType: "ac_campaign", sourceId: null, providerMessageId: pid,
      to: contact.email, from: null, subject: c.subject || "(no subject)",
      body: "", bodyPreview: c.subject || "",
      status: c.clicks > 0 ? "clicked" : c.opens > 0 ? "opened" : "sent",
      createdAt: c.sdate,
    });
  }

  // Bulk campaigns -- AC's API has no per-recipient OPEN signal for these
  // at all (tested, confirmed absent -- see fetchAcContactActivities's
  // own comment in import_backend.js), only real per-recipient send +
  // click. Click is still a genuinely-attributed signal, not a guess.
  const { logs, linkData } = await fetchAcContactActivities(acContactId);
  for (const l of logs) {
    const pid = `ac_send:${l.id}`;
    if (readJson(PROVIDER_ID_INDEX_FILE, {})[pid]) continue;
    const name = await acCampaignName(l.campaign);
    logMessage({
      channel: "email", direction: "outbound", contactId,
      sourceType: "ac_campaign", sourceId: null, providerMessageId: pid,
      to: contact.email, from: null, subject: name, body: "", bodyPreview: name,
      status: "sent", createdAt: l.tstamp,
    });
  }
  for (const c of linkData) {
    const pid = `ac_click:${c.id}`;
    if (readJson(PROVIDER_ID_INDEX_FILE, {})[pid]) continue;
    const name = await acCampaignName(c.campaign);
    logMessage({
      channel: "email", direction: "outbound", contactId,
      sourceType: "ac_campaign", sourceId: null, providerMessageId: pid,
      to: contact.email, from: null, subject: name,
      body: `Clicked a link (${c.times || 1}x)`, bodyPreview: name,
      status: "clicked", createdAt: c.tstamp,
    });
  }
}

// One-time/on-demand catch-up for contacts NOBODY has reopened since a
// recent AC send -- e.g. today's 4 campaigns, before anyone's clicked
// back into those specific conversations. Deliberately NOT "every AC-
// linked contact" (160,623 of them -- checked live) -- that's the exact
// 176K-contact-sweep mistake already ruled out earlier tonight. Scoped
// instead to contacts with REAL recent activity in this CRM already
// (bounded, already-indexed via SQLite), which is who a recent campaign
// send would actually touch.
export async function syncAcEngagementForRecentContacts(sinceMs) {
  if (!acConfigured()) return { checked: 0, contacts: 0 };
  const contactIds = getRecentlyActiveContactIds(sinceMs);
  let checked = 0;
  for (const contactId of contactIds) {
    try { await syncAcEngagementForContact(contactId); checked++; }
    catch (e) { console.error("[ac_sync] failed for contact", contactId, e.message); }
  }
  return { checked, contacts: contactIds.length };
}
