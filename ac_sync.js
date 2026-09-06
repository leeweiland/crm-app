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
import { readJson, appendToJsonObjectFast } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { logMessage, PROVIDER_ID_INDEX_FILE } from "./message_log.js";
import { getContactMessages, updateContactMessagesByIds } from "./message_index.js";
import { acConfigured, fetchAcOneToOneCampaigns, fetchAcContactActivities, acCampaignName, AC_BASE } from "./import_backend.js";
import { getRecentlyActiveContactIds } from "./sqlite_inbox.js";

// The SAME campaign gets sent to every one of its recipients -- storing
// its HTML on each recipient's own message record duplicated it once per
// recipient instead of once per campaign, and confirmed live to fill a
// 46GB volume solid before the repair even finished. This is the actual
// fix: one shared, persisted store keyed by campaign id (bounded by
// distinct campaigns actually sent -- hundreds to a few thousand over
// years of AC use -- not by message count, which runs into the millions).
// Every per-contact record just carries a reference (extra.acCampaignId
// on logMessage, see below) and resolves the real body from here at
// display time (see inbox_backend.js) -- never persisted onto the
// message itself.
export const AC_CAMPAIGN_BODIES_FILE = "crm_ac_campaign_bodies.json";

// AC's /campaigns collection never carries the actual sent HTML -- only
// stats/metadata (confirmed by inspecting a real campaign object's own
// field list). The real content lives on a separate `message` resource,
// reachable via the campaign's own message_id.
//
// Tracks in-flight fetches (not just the persisted result) -- two
// concurrent callers both missing the persisted cache for the SAME new
// campaign would otherwise both fetch AND both append the same key to
// AC_CAMPAIGN_BODIES_FILE (appendToJsonObjectFast has no dedup of its
// own, same as its other caller PROVIDER_ID_INDEX_FILE relies on the
// check-before-append pattern to avoid).
const inFlight = new Map();
export async function getAcCampaignHtml(campaignId) {
  const stored = readJson(AC_CAMPAIGN_BODIES_FILE, {})[campaignId];
  if (stored !== undefined) return stored; // "" is a valid (confirmed-empty) cached result, not a miss
  if (inFlight.has(campaignId)) return inFlight.get(campaignId);
  const promise = (async () => {
    let html = "";
    try {
      const headers = { "Api-Token": process.env.AC_API_KEY };
      const cr = await fetch(`${AC_BASE}/api/3/campaigns/${campaignId}`, { headers });
      const messageId = cr.ok ? (await cr.json()).campaign?.message_id : null;
      if (messageId) {
        const mr = await fetch(`${AC_BASE}/api/3/messages/${messageId}`, { headers });
        if (mr.ok) html = (await mr.json()).message?.html || "";
      }
    } catch (e) {
      console.error("[ac_sync] fetching campaign HTML failed for", campaignId, e.message);
    }
    appendToJsonObjectFast(AC_CAMPAIGN_BODIES_FILE, campaignId, html);
    return html;
  })();
  inFlight.set(campaignId, promise);
  try { return await promise; } finally { inFlight.delete(campaignId); }
}
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
  //
  // body is deliberately left empty here -- extra.acCampaignId is a
  // reference into AC_CAMPAIGN_BODIES_FILE (see getAcCampaignHtml's own
  // comment), resolved at display time by inbox_backend.js instead of
  // duplicated onto every recipient's own record.
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
      createdAt: c.sdate, extra: { acCampaignId: c.id },
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
      status: "sent", createdAt: l.tstamp, extra: { acCampaignId: l.campaign },
    });
  }
  for (const c of linkData) {
    const pid = `ac_click:${c.id}`;
    if (readJson(PROVIDER_ID_INDEX_FILE, {})[pid]) continue;
    const name = await acCampaignName(c.campaign);
    logMessage({
      channel: "email", direction: "outbound", contactId,
      sourceType: "ac_campaign", sourceId: null, providerMessageId: pid,
      to: contact.email, from: null, subject: name, body: "", bodyPreview: name,
      status: "clicked", createdAt: c.tstamp, extra: { acCampaignId: c.campaign },
    });
  }

  // Attaches acCampaignId to older records missing it -- both this sync's
  // earliest records (briefly stored full duplicated bodies instead of a
  // reference, before this fix existed) AND the original week-long
  // historical import's ("ac_import", import_backend.js's mergeAcCampaigns/
  // mergeAcContactActivities). A cheap reference, NOT the html itself --
  // display-time resolution reads AC_CAMPAIGN_BODIES_FILE directly, so
  // nothing here needs to fetch or store any actual content.
  //
  // logs/linkData (already fetched above) map each activity id straight
  // to its campaign id, which is exactly what's missing from a record's
  // own id field alone. The old import stored this as acActivityId (not
  // providerMessageId) -- this sync's own records use providerMessageId
  // instead, but in the identical `ac_send:<activity id>`/`ac_click:
  // <activity id>` shape, so the same lookup covers both.
  const activityCampaignId = new Map();
  for (const l of logs) activityCampaignId.set(`ac_send:${l.id}`, l.campaign);
  for (const c of linkData) activityCampaignId.set(`ac_click:${c.id}`, c.campaign);
  const resolveCampaignId = (m) => {
    if (m.acCampaignId) return m.acCampaignId; // old import: 1:1 campaign row, or already-repaired
    if (m.acActivityId) return activityCampaignId.get(m.acActivityId); // old import: send/click row
    if (m.providerMessageId?.startsWith("ac_1to1:")) return m.providerMessageId.slice("ac_1to1:".length);
    return activityCampaignId.get(m.providerMessageId); // this sync's own send/click rows
  };
  const needsRef = getContactMessages(contactId).filter(m => (m.sourceType === "ac_campaign" || m.sourceType === "ac_import") && !m.acCampaignId);
  if (needsRef.length) {
    const refs = new Map(); // message id -> campaignId
    for (const m of needsRef) {
      const campaignId = resolveCampaignId(m);
      if (campaignId) refs.set(m.id, campaignId); // no match (e.g. AC's own retention window) just stays unresolved, retried next open
    }
    if (refs.size) {
      // Seeds the shared store from any already-duplicated body BEFORE
      // clearing it -- this content was already paid for (a real AC API
      // fetch), and re-fetching it fresh could come back empty if AC's
      // own retention has since dropped it. Only ever fills a genuinely
      // missing key (readJson(...)[id] === undefined), never overwrites
      // an already-cached value.
      const cached = readJson(AC_CAMPAIGN_BODIES_FILE, {});
      for (const m of needsRef) {
        const campaignId = refs.get(m.id);
        if (campaignId && m.body && cached[campaignId] === undefined) {
          appendToJsonObjectFast(AC_CAMPAIGN_BODIES_FILE, campaignId, m.body);
          cached[campaignId] = m.body; // keep this pass's own view in sync so a second dupe this loop doesn't re-append
        }
      }
      updateContactMessagesByIds(contactId, new Set(refs.keys()), m => {
        m.acCampaignId = refs.get(m.id);
        // Clears an already-duplicated body from before this fix existed
        // (now safely preserved above) -- the display layer resolves it
        // from the shared store instead, so keeping a stale local copy
        // just wastes disk for no reason.
        if (m.body) { m.body = ""; }
      });
    }
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
