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
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { readJson, writeJson, appendToJsonObjectFast, DATA_DIR } from "./auth_backend.js";
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
      // Timeout matters even more here than in the scheduler batch below --
      // this is also called live from inbox_backend.js's contact-activity
      // endpoint, so a hung AC response would otherwise hang that request
      // (and, via guardedTick, potentially the whole scheduler too when
      // called from the batch instead).
      const cr = await fetch(`${AC_BASE}/api/3/campaigns/${campaignId}`, { headers, signal: AbortSignal.timeout(10000) });
      const messageId = cr.ok ? (await cr.json()).campaign?.message_id : null;
      if (messageId) {
        const mr = await fetch(`${AC_BASE}/api/3/messages/${messageId}`, { headers, signal: AbortSignal.timeout(10000) });
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

// ── Full account-wide reference fill, batched across scheduler ticks ────
// A one-off `railway ssh` script doing this same sweep died TWICE tonight
// mid-run -- once from hitting AC's rate limit, once from an unrelated
// deploy (this app is being worked on by more than one session right
// now) restarting the container, which wipes /tmp and kills anything
// running outside the app's own process with it. Neither this app's own
// process nor its state survives a restart by accident -- but its STATE
// is persisted to /data (survives) and its CODE is deployed with the app
// (comes back up automatically) and its SCHEDULE resumes on its own the
// next tick after any restart, deploy, or crash, the exact same proven
// shape as processCloseAltBackfillBatch in import_backend.js. No separate
// process, no watchdog, no /tmp -- it just can't get "fucked up" by a
// restart the way the standalone script did, because there's nothing
// living outside the app for a restart to wipe.
export const AC_REF_FILL_STATE_FILE = "crm_ac_ref_fill_state.json";
const AC_REF_FILL_BATCH_MS = 20000; // leaves headroom inside the 30s tick
const MSG_BY_CONTACT_DIR = "msg_by_contact";

// A hung (not erroring, just never responding) AC request would otherwise
// block this call forever -- and since this runs inside the scheduler's
// own guardedTick, a tick that never returns means _tickRunning never
// clears, which skips every OTHER scheduled phase (Gmail polling,
// campaign sends, etc.) right along with it. Same fix gmail_backend.js's
// gmailFetchTimeout already applies to its own calls, for the identical
// reason.
function acFetchTimeout() { return AbortSignal.timeout(10000); }
async function fetchAcWithRetry(url) {
  const headers = { "Api-Token": process.env.AC_API_KEY };
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try { r = await fetch(url, { headers, signal: acFetchTimeout() }); }
    catch { await new Promise(res => setTimeout(res, 500 * (attempt + 1))); continue; }
    if (r.ok) return r;
    if (r.status === 429 || r.status >= 500) {
      const retryAfter = Number(r.headers.get("retry-after")) || (1 + attempt);
      await new Promise(res => setTimeout(res, retryAfter * 1000));
      continue;
    }
    return r; // genuine 4xx -- not retryable
  }
  return null;
}
// Full pagination, not a single page -- a contact's own activity history
// can run past what one page returns (confirmed live: a contact with 377
// total activities, the one this repair needed was on page 4), which is
// exactly what a repair pass is most likely to need since it's chasing
// OLD records by definition.
async function getAllContactActivitiesPaged(acContactId) {
  let offset = 0, logs = [], linkData = [], total = Infinity;
  while (offset < total) {
    const r = await fetchAcWithRetry(`${AC_BASE}/api/3/activities?contact=${acContactId}&limit=100&offset=${offset}`);
    if (!r || !r.ok) break;
    const d = await r.json();
    logs.push(...(d.logs || []));
    linkData.push(...(d.linkData || []));
    total = Number(d.meta?.total) || 0;
    const got = (d.logs || []).length + (d.linkData || []).length;
    if (got === 0) break;
    offset += got;
  }
  return { logs, linkData };
}

// Processes one file -- pulled out of the loop below so a whole SLICE of
// files can run concurrently instead of one network round trip at a
// time. Returns true if it changed anything (caller only writes the file
// back when it did).
async function processOneAcRefFile(dir, f, acContactIdByContactId, state) {
  const contactId = f.replace(/\.json$/, "");
  const path = join(dir, f);
  let msgs;
  try { msgs = JSON.parse(readFileSync(path, "utf8")); } catch { return; }
  const needsRef = msgs.filter(m => (m.sourceType === "ac_campaign" || m.sourceType === "ac_import") && !m.acCampaignId);
  if (!needsRef.length) return;
  let activityMap = null;
  let changed = false;
  for (const m of needsRef) {
    let campaignId = m.providerMessageId?.startsWith("ac_1to1:") ? m.providerMessageId.slice("ac_1to1:".length) : null;
    if (!campaignId) {
      const activityKey = m.acActivityId || m.providerMessageId;
      if (!activityKey) continue;
      if (!activityMap) {
        const acContactId = acContactIdByContactId.get(contactId);
        if (!acContactId) { activityMap = new Map(); }
        else {
          const { logs, linkData } = await getAllContactActivitiesPaged(acContactId);
          activityMap = new Map();
          for (const l of logs) activityMap.set(`ac_send:${l.id}`, l.campaign);
          for (const c of linkData) activityMap.set(`ac_click:${c.id}`, c.campaign);
        }
      }
      campaignId = activityMap.get(activityKey);
      if (!campaignId) continue;
    }
    m.acCampaignId = campaignId;
    if (m.body) m.body = ""; // reclaim an already-duplicated body from before the dedup fix existed
    changed = true;
    state.refsAttached++;
    await getAcCampaignHtml(campaignId); // warms the shared store in the same pass
  }
  if (changed) writeFileSync(path, JSON.stringify(msgs));
}

// Concurrency within a batch, not just across ticks -- sequential (one
// file, one activity fetch, awaited before starting the next) confirmed
// live at ~1 file/sec, a ~2-DAY runtime for the full 173,680. A slice
// processed with several requests in flight at once is still exactly as
// resumable: nextIndex only advances past a slice once the WHOLE slice's
// Promise.all resolves, so a mid-slice crash just re-processes that slice
// on the next tick -- cheap, since every file already fixed short-circuits
// instantly via needsRef.length, only the genuinely-unfinished ones in
// that slice redo real work.
const AC_REF_FILL_CONCURRENCY = 10;
const AC_REF_FILL_SLICE_SIZE = 100;

export async function processAcRefFillBatch() {
  if (!acConfigured()) return;
  const state = readJson(AC_REF_FILL_STATE_FILE, { nextIndex: 0, filesScanned: 0, refsAttached: 0, done: false });
  if (state.done) return;

  const dir = join(DATA_DIR, MSG_BY_CONTACT_DIR);
  let files;
  try { files = readdirSync(dir); } catch { return; }
  if (state.nextIndex >= files.length) {
    state.done = true;
    writeJson(AC_REF_FILL_STATE_FILE, state);
    console.log(`[ac-ref-fill] done -- ${state.filesScanned} files scanned, ${state.refsAttached} refs attached`);
    return;
  }

  // Rebuilt every batch (not persisted across batches) -- cheap (readJson
  // is mtime-cached) and always reflects the current contacts file rather
  // than a snapshot that could go stale across a run spanning many ticks.
  const contacts = readJson(CONTACTS_FILE, []);
  const acContactIdByContactId = new Map(contacts.map(c => [c.id, c.externalIds?.acContactId]).filter(([, v]) => v));

  const t0 = Date.now();
  const startIndex = state.nextIndex;
  while (state.nextIndex < files.length && Date.now() - t0 < AC_REF_FILL_BATCH_MS) {
    const slice = files.slice(state.nextIndex, state.nextIndex + AC_REF_FILL_SLICE_SIZE);
    let next = 0;
    await Promise.all(Array.from({ length: AC_REF_FILL_CONCURRENCY }, async () => {
      while (next < slice.length) {
        const f = slice[next++];
        await processOneAcRefFile(dir, f, acContactIdByContactId, state);
        state.filesScanned++;
      }
    }));
    state.nextIndex += slice.length;
  }
  writeJson(AC_REF_FILL_STATE_FILE, state);
  console.log(`[ac-ref-fill] ${state.nextIndex}/${files.length} scanned (+${state.nextIndex - startIndex} this batch), ${state.refsAttached} refs attached so far`);
}
