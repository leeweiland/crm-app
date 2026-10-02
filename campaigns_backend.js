import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { matchesSegment, SEGMENTS_FILE } from "./contacts_backend.js";
import { getAllContacts } from "./contacts_db.js";
import { sendEmail, reconstructEmailBody } from "./email_backend.js";
import { getMessagesForSource } from "./message_log.js";
import { maybeSnapshotVersion, listVersions, getVersion } from "./versions_shared.js";
import { getEmailTheme } from "./integrations_backend.js";
import { AC_CAMPAIGN_META_FILE, AC_CAMPAIGN_BODIES_FILE, AC_CAMPAIGN_STATS_FILE, getAcCampaignHtml, acPlainPreview } from "./ac_sync.js";
import { getBackgroundWorker } from "./background_worker_handle.js";

export const CAMPAIGNS_FILE = "crm_campaigns.json";
export const CAMPAIGN_VERSIONS_FILE = "crm_campaign_versions.json";
const VERSIONED_FIELDS = ["name", "subject", "previewText", "blocks", "theme", "footerTemplateId", "recipients"];
function campaignSnapshotFields(campaign) {
  const out = {};
  for (const k of VERSIONED_FIELDS) out[k] = campaign[k];
  return out;
}

// Each POPULATED criterion (lists, tags, segment) narrows the audience --
// AND across categories, same as any normal filter UI ("in this list AND
// matches this segment"), OR only within a category ("in any of these
// lists"). Previously ORed every category together, so picking a segment
// to narrow an already-selected list did nothing (segment membership is
// near-always a subset of a list that broad) -- confirmed live: adding the
// 157k-member ONLINE list to a 23-person "last 72h" segment jumped the
// recipient count to 80k instead of narrowing it, since matching the list
// ALONE was enough to qualify. An empty category is skipped entirely
// (doesn't restrict), so leaving Tags blank while using Lists+Segment still
// works as expected.
function resolveRecipients({ listIds, tagIds, segmentId, excludeListIds }) {
  const contacts = getAllContacts();
  const segment = segmentId ? readJson(SEGMENTS_FILE, []).find(s => s.id === segmentId) : null;
  const hasFilters = (listIds?.length) || (tagIds?.length) || segment;
  return contacts.filter(c => {
    if (c.emailOptOut || !c.email) return false;
    if (excludeListIds?.length && (c.listIds || []).some(id => excludeListIds.includes(id))) return false;
    if (!hasFilters) return true; // no targeting = everyone (minus opt-outs/exclusions above)
    if (listIds?.length && !(c.listIds || []).some(id => listIds.includes(id))) return false;
    if (tagIds?.length && !(c.tags || []).some(id => tagIds.includes(id))) return false;
    if (segment && !matchesSegment(c, segment.filter)) return false;
    return true;
  });
}

function rollupStats(campaignId) {
  const messages = getMessagesForSource("campaign", campaignId);
  const stats = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 };
  for (const m of messages) {
    if (["sent", "delivered", "opened", "clicked"].includes(m.status)) stats.sent++;
    if (["delivered", "opened", "clicked"].includes(m.status)) stats.delivered++;
    if (["opened", "clicked"].includes(m.status)) stats.opened++;
    if (m.status === "clicked") stats.clicked++;
    if (m.status === "bounced") stats.bounced++;
    if (m.status === "complained") stats.unsubscribed++;
  }
  return stats;
}

// Exported so scheduler.js can trigger a due scheduled campaign without an
// HTTP round-trip -- same "small reusable function, not internal HTTP"
// convention as sendEmail() itself.
// Kicks off sending and returns immediately -- does NOT await the send
// loop. A 20k-recipient campaign sending one-at-a-time (SES has no bulk
// endpoint) can take many minutes; the old version awaited the entire loop
// inside the HTTP request handler, so the browser's Send Now request would
// sit open for that whole duration with zero feedback, almost certainly
// past any reverse-proxy/browser timeout on a large list. Progress is
// written to campaign.sendProgress after every send so campaigns.html can
// poll and show a live "Sending X/Y" badge; status becomes "sent" only
// once the loop actually finishes, or "send_error" if the loop itself
// throws (an individual recipient's send failure is NOT fatal -- sendEmail
// already reports {ok:false} for that one and the loop continues, same as
// before this change).
// Resumable: skips anyone who already has a logged message for this
// campaign (any status -- sent/delivered/opened/bounced all mean "already
// contacted", never re-send that same person). This is what makes it safe
// to call sendCampaignNow again on a campaign that's already partway sent
// -- necessary because the loop below runs in-process with zero
// persistence, and a deploy restarting the container mid-send kills it
// silently, no error, no retry. Confirmed live: a real campaign got stuck
// at "sending" for 2 days after an unrelated deploy landed mid-flight,
// with 1035 of 1640 recipients never contacted and nothing surfacing the
// failure. See scheduler.js's own auto-resume job, which calls this
// exact function again on anything stuck.
function alreadyContactedIds(campaignId) {
  return new Set(getMessagesForSource("campaign", campaignId).map(m => m.contactId).filter(Boolean));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Confirmed live via SES's own GetAccount API: this account's real
// MaxSendRate is 14/sec (Max24HourSend 50,000) -- the actual ceiling on
// how fast ANY sender using this account can go. Targeted at 13/sec (a
// hair under, not right up against it).
// SENDING_CONCURRENCY is NOT "raise this and throughput goes up" --
// confirmed live raising it 10 -> 20 made real throughput WORSE (5.8/sec
// -> 4.5/sec), because every send in the same campaign appends to the
// SAME shared file (msg_by_source/campaign__<id>.json, see
// appendSourceMessage), lock-protected (withFileLock in auth_backend.js)
// against concurrent writers. More concurrent sends just means more of
// them queued up contending for that one lock, not more real parallelism
// -- the actual bottleneck is that shared serialized write, not SES's own
// round-trip latency. Left at a moderate 12 (close to the target rate
// itself) rather than over-provisioning against a bottleneck concurrency
// can't fix; the per-batch pad below is what enforces 13/sec once a batch
// completes faster than its fair share of a second.
const SENDING_CONCURRENCY = 12;
const SES_MAX_SEND_RATE = 13;

// Split from sendCampaignNow so the actual per-recipient work can run on
// the background worker thread instead of inline on whichever thread
// kicked it off -- see background_worker.js's own header comment: this
// exact "bulk send + resulting webhook flood pins the main thread" pattern
// is what that worker was built for, but the campaign /send route never
// actually got wired to hand off to it (only the SES/Twilio webhook routes
// did) -- confirmed live: manually re-triggering a send via the API,
// versus letting the scheduler's own stuck-campaign resume pick it back
// up, was the difference between the whole CRM hanging and not. Re-derives
// recipients/remaining fresh rather than taking them as arguments -- this
// can run on a different thread than whatever called sendCampaignNow, so
// nothing from that call's closure is safe to rely on here.
export async function runCampaignSendLoop(campaignId) {
  const campaigns = readJson(CAMPAIGNS_FILE, []);
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) return;
  const allRecipients = resolveRecipients(campaign.recipients || {});
  const contacted = alreadyContactedIds(campaignId);
  const remaining = allRecipients.filter(c => !contacted.has(c.id));

  try {
    let sentThisRun = 0;
      // SENDING_CONCURRENCY recipients in flight at once instead of one at
      // a time -- confirmed live this was the actual reason a send to
      // thousands of contacts took hours instead of minutes: each
      // sendEmail is a real network round-trip, and awaiting them fully
      // sequentially meant total time scaled linearly with recipient
      // count, nowhere close to what this SES account can actually sustain.
      for (let i = 0; i < remaining.length; i += SENDING_CONCURRENCY) {
        // Re-read fresh every batch (not just trust the in-memory
        // `campaign` from when this run started) -- this is how Cancel
        // actually stops an in-flight send: flipping status away from
        // "sending" (see the /cancel route below) is picked up here within
        // one batch, instead of the loop having no way to know and running
        // to completion regardless.
        const liveCampaigns = readJson(CAMPAIGNS_FILE, []);
        const live = liveCampaigns.find(c => c.id === campaignId);
        if (!live || live.status !== "sending") {
          console.log(`[campaign send] ${campaignId} stopping -- status is now "${live?.status ?? "(deleted)"}", not "sending"`);
          return;
        }
        const batch = remaining.slice(i, i + SENDING_CONCURRENCY);
        const batchStartedAt = Date.now();
        // Caught per-send (not left to reject the whole batch/run) --
        // before this, ANY single failure (a bad address, a transient SES
        // error) killed the entire remaining send via the outer catch;
        // that's tolerable at one-at-a-time speed but would waste a huge
        // amount of an already-in-flight batch at real concurrency.
        await Promise.all(batch.map((contact) =>
          sendEmail({
            to: contact.email, subject: campaign.subject, previewText: campaign.previewText, blocks: campaign.blocks, theme: campaign.theme,
            footerTemplateId: campaign.footerTemplateId, contactId: contact.id,
            sourceType: "campaign", sourceId: campaign.id,
          }).catch((e) => console.error(`[campaign send] ${campaignId} contact ${contact.id} failed:`, e.message))
        ));
        sentThisRun += batch.length;
        const latest = readJson(CAMPAIGNS_FILE, []);
        const c = latest.find(x => x.id === campaignId);
        if (c) {
          c.sendProgress = { total: allRecipients.length, sent: allRecipients.length - remaining.length + sentThisRun };
          c.updatedAt = new Date().toISOString();
          writeJson(CAMPAIGNS_FILE, latest);
        }
        // Pad this batch's own wall-clock time up to what SENDING_CONCURRENCY
        // sends should minimally take at the account's real rate limit,
        // rather than assuming SES call latency alone keeps us under it --
        // a fast batch (SES responding quickly, little else contending)
        // could otherwise exceed 14/sec and get throttled.
        const minBatchMs = (batch.length / SES_MAX_SEND_RATE) * 1000;
        const elapsed = Date.now() - batchStartedAt;
        if (elapsed < minBatchMs) await sleep(minBatchMs - elapsed);
      }
      const finalCampaigns = readJson(CAMPAIGNS_FILE, []);
      const finalCampaign = finalCampaigns.find(c => c.id === campaignId);
      // Still "sending" (not cancelled out from under us mid-loop) --
      // the cancel check above already returns early otherwise.
      if (finalCampaign && finalCampaign.status === "sending") {
        finalCampaign.status = "sent";
        finalCampaign.sentAt = finalCampaign.sentAt || new Date().toISOString();
        finalCampaign.sendProgress = { total: allRecipients.length, sent: allRecipients.length };
        finalCampaign.stats = rollupStats(campaignId);
        writeJson(CAMPAIGNS_FILE, finalCampaigns);
      }
  } catch (e) {
    console.error(`[campaign send] ${campaignId} failed:`, e.message);
    const errCampaigns = readJson(CAMPAIGNS_FILE, []);
    const errCampaign = errCampaigns.find(c => c.id === campaignId);
    if (errCampaign) { errCampaign.status = "send_error"; errCampaign.sendError = e.message; writeJson(CAMPAIGNS_FILE, errCampaigns); }
  }
}

// Sets up (marks "sending", captures the initial progress numbers the
// caller's HTTP response needs) then hands the actual work to
// runCampaignSendLoop -- on the background worker thread when one's
// available (see background_worker.js), inline otherwise (no
// BACKGROUND_WORKER configured, e.g. local dev). getBackgroundWorker()
// only ever returns non-null on the MAIN thread (that's the only thread
// server.js's setBackgroundWorker call runs on) -- so when the SCHEDULER's
// own tick (which already runs ON the worker thread once BACKGROUND_WORKER
// is set) calls this for a due/stuck campaign, it correctly falls through
// to running the loop directly right there instead of trying to hand off
// to itself.
export function sendCampaignNow(campaignId) {
  const campaigns = readJson(CAMPAIGNS_FILE, []);
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) return { ok: false, reason: "not_found" };
  const allRecipients = resolveRecipients(campaign.recipients || {});
  const contacted = alreadyContactedIds(campaignId);
  const remaining = allRecipients.filter(c => !contacted.has(c.id));
  campaign.status = "sending";
  campaign.sendProgress = { total: allRecipients.length, sent: allRecipients.length - remaining.length };
  // Set immediately (not just at each progress checkpoint below) so the
  // scheduler's stuck-campaign check -- which looks at how long updatedAt
  // has been stale -- doesn't see a JUST-(re)started send as already stale
  // and try to resume it a second time in parallel.
  campaign.updatedAt = new Date().toISOString();
  writeJson(CAMPAIGNS_FILE, campaigns);

  const worker = getBackgroundWorker();
  if (worker) worker.postMessage({ type: "send_campaign", campaignId });
  else runCampaignSendLoop(campaignId);

  return { ok: true, recipientCount: remaining.length, totalRecipients: allRecipients.length };
}

export async function handleCampaignsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/campaigns")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/campaigns" && req.method === "GET") {
    const campaigns = readJson(CAMPAIGNS_FILE, []).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return sendJson(res, 200, { campaigns });
  }
  // Full HTML for one native campaign, fetched separately from the list
  // (which never needs more than name/subject/stats) -- placed ahead of
  // the generic /api/campaigns/:id match below so this literal path wins.
  const campaignBodyMatch = p.match(/^\/api\/campaigns\/([^/]+)\/body$/);
  if (campaignBodyMatch && req.method === "GET") {
    const html = reconstructEmailBody({ sourceType: "campaign", sourceId: campaignBodyMatch[1], contactId: null, id: null });
    return sendJson(res, 200, { html, note: html ? null : "No preview available yet -- this campaign hasn't sent a real email to reconstruct from." });
  }
  // Read-only ActiveCampaign-sourced bulk campaigns (not automation-
  // triggered -- those live in automations.html's own Templates tab
  // instead, see automations_backend.js's identical split) -- a separate
  // list/endpoint rather than merged into the native campaigns above:
  // clicking a native row navigates to campaign-builder.html to EDIT it,
  // which makes no sense for a campaign that only ever existed in AC.
  if (p === "/api/campaigns/external" && req.method === "GET") {
    const acMeta = readJson(AC_CAMPAIGN_META_FILE, {});
    const acBodies = readJson(AC_CAMPAIGN_BODIES_FILE, {});
    const acStats = readJson(AC_CAMPAIGN_STATS_FILE, {});
    const external = Object.entries(acMeta)
      .filter(([, meta]) => !meta.isAutomation)
      .map(([campaignId, meta]) => ({
        id: campaignId, subject: meta.subject || meta.name || "(no subject)",
        // Cheap -- already sitting in the shared store from getAcCampaignHtml's
        // own fetch, just read and stripped here, no extra AC API call.
        bodyPreview: acPlainPreview(acBodies[campaignId], 140),
        // Tallied incrementally by ac_sync.js's reference-fill batch.
        stats: acStats[campaignId] || null,
      }));
    return sendJson(res, 200, { campaigns: external });
  }
  const externalBodyMatch = p.match(/^\/api\/campaigns\/external\/([^/]+)\/body$/);
  if (externalBodyMatch && req.method === "GET") {
    const html = await getAcCampaignHtml(externalBodyMatch[1]);
    return sendJson(res, 200, { html: html || null });
  }
  if (p === "/api/campaigns" && req.method === "POST") {
    const { name } = await readJsonBody(req);
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = {
      id: randomUUID(), name: name || "Untitled Campaign", status: "draft",
      subject: "", previewText: "", blocks: [], theme: getEmailTheme(), footerTemplateId: null,
      recipients: { listIds: [], tagIds: [], segmentId: null, excludeListIds: [] },
      scheduledAt: null, sentAt: null,
      stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    campaigns.push(campaign);
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign });
  }

  const duplicateMatch = p.match(/^\/api\/campaigns\/([^/]+)\/duplicate$/);
  if (duplicateMatch && req.method === "POST") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const source = campaigns.find(c => c.id === duplicateMatch[1]);
    if (!source) return sendJson(res, 404, { error: "Not found" });
    const copy = {
      id: randomUUID(), name: `Copy of ${source.name}`, status: "draft",
      subject: source.subject, previewText: source.previewText || "", blocks: JSON.parse(JSON.stringify(source.blocks)),
      theme: JSON.parse(JSON.stringify(source.theme || getEmailTheme())),
      footerTemplateId: source.footerTemplateId,
      recipients: JSON.parse(JSON.stringify(source.recipients)),
      scheduledAt: null, sentAt: null,
      stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    campaigns.push(copy);
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign: copy });
  }

  // Bulk reset (Settings > Email Theme's "reset all" button) -- re-copies
  // the current org theme into every campaign. A single campaign's own
  // "Reset to default" (in its editor) just updates local state and goes
  // out through the normal autosave path instead of a dedicated endpoint.
  if (p === "/api/campaigns/reset-all-themes" && req.method === "POST") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const theme = getEmailTheme();
    campaigns.forEach(c => { c.theme = { ...theme }; c.updatedAt = new Date().toISOString(); });
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, count: campaigns.length });
  }

  const campaignMatch = p.match(/^\/api\/campaigns\/([^/]+)$/);
  if (campaignMatch) {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === campaignMatch[1]);
    if (req.method === "GET") {
      if (!campaign) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, { campaign });
    }
    if (req.method === "PATCH") {
      if (!campaign) return sendJson(res, 404, { error: "Not found" });
      const body = await readJsonBody(req);
      const locked = campaign.status === "sent" || campaign.status === "sending";
      // Once sent, everything that actually went out (subject/blocks/
      // recipients/etc) has to stay locked -- editing those after the fact
      // would misrepresent what was really sent. But the campaign's name
      // is just an internal organizational label nobody outside this CRM
      // ever sees, so there's no reason renaming a sent campaign (for
      // tidying up the list later) needs to be blocked along with it. The
      // frontend's autosave always PATCHes the full field set (not just
      // whatever changed), so a locked campaign quietly no-ops every field
      // except name instead of rejecting the whole request.
      if (locked && !("name" in body)) return sendJson(res, 400, { error: "Can't edit a campaign that's already sending or sent" });
      const fieldsToApply = locked ? ["name"] : VERSIONED_FIELDS;
      // Snapshot the pre-change state before overwriting it -- throttled
      // (see versions_shared.js) so this doesn't create a new version on
      // every debounced autosave, just roughly once per editing session.
      if (!locked) maybeSnapshotVersion(CAMPAIGN_VERSIONS_FILE, "campaignId", campaign.id, campaignSnapshotFields(campaign));
      for (const k of fieldsToApply) if (k in body) campaign[k] = body[k];
      campaign.updatedAt = new Date().toISOString();
      writeJson(CAMPAIGNS_FILE, campaigns);
      return sendJson(res, 200, { ok: true, campaign });
    }
    if (req.method === "DELETE") {
      writeJson(CAMPAIGNS_FILE, campaigns.filter(c => c.id !== campaignMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  const versionsMatch = p.match(/^\/api\/campaigns\/([^/]+)\/versions$/);
  if (versionsMatch && req.method === "GET") {
    return sendJson(res, 200, { versions: listVersions(CAMPAIGN_VERSIONS_FILE, "campaignId", versionsMatch[1]) });
  }
  const restoreMatch = p.match(/^\/api\/campaigns\/([^/]+)\/versions\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === "POST") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === restoreMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Campaign not found" });
    const version = getVersion(CAMPAIGN_VERSIONS_FILE, "campaignId", campaign.id, restoreMatch[2]);
    if (!version) return sendJson(res, 404, { error: "Version not found" });
    // Snapshot the current (pre-restore) state too, unthrottled -- a
    // restore is a deliberate action, not a routine autosave, so it always
    // gets its own undo point even if one was just taken seconds ago.
    maybeSnapshotVersion(CAMPAIGN_VERSIONS_FILE, "campaignId", campaign.id, campaignSnapshotFields(campaign), { force: true });
    Object.assign(campaign, version.snapshot);
    campaign.updatedAt = new Date().toISOString();
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign });
  }

  const previewMatch = p.match(/^\/api\/campaigns\/([^/]+)\/preview-recipients$/);
  if (previewMatch && req.method === "GET") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === previewMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Not found" });
    const recipients = resolveRecipients(campaign.recipients || {});
    return sendJson(res, 200, { count: recipients.length });
  }

  const sendMatch = p.match(/^\/api\/campaigns\/([^/]+)\/send$/);
  if (sendMatch && req.method === "POST") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === sendMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Not found" });
    if (!campaign.subject || !campaign.blocks?.length) return sendJson(res, 400, { error: "Add a subject and at least one block before sending" });
    // sendCampaignNow is synchronous now and kicks off the actual send loop
    // in the background -- this returns almost immediately regardless of
    // recipient count (see its own comment), so the browser doesn't sit on
    // an open request for a large send.
    const result = sendCampaignNow(campaign.id);
    return sendJson(res, 200, result);
  }

  // Stops an in-flight send within one batch (see sendCampaignNow's own
  // fresh-status re-read each iteration) -- everyone already sent to stays
  // sent, tracked exactly the same way a resumed/re-sent campaign already
  // skips them (alreadyContactedIds). Re-sending later (POST .../send
  // again) picks up only whoever's left, same as resuming after a crash.
  const cancelMatch = p.match(/^\/api\/campaigns\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === cancelMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Not found" });
    if (campaign.status !== "sending") return sendJson(res, 400, { error: "Not currently sending" });
    campaign.status = "cancelled";
    campaign.updatedAt = new Date().toISOString();
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign });
  }

  const scheduleMatch = p.match(/^\/api\/campaigns\/([^/]+)\/schedule$/);
  if (scheduleMatch && req.method === "POST") {
    const { scheduledAt } = await readJsonBody(req);
    if (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now()) return sendJson(res, 400, { error: "scheduledAt must be a valid future date/time" });
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === scheduleMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Not found" });
    if (!campaign.subject || !campaign.blocks?.length) return sendJson(res, 400, { error: "Add a subject and at least one block before scheduling" });
    campaign.status = "scheduled";
    campaign.scheduledAt = scheduledAt;
    campaign.updatedAt = new Date().toISOString();
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign });
  }

  const unscheduleMatch = p.match(/^\/api\/campaigns\/([^/]+)\/unschedule$/);
  if (unscheduleMatch && req.method === "POST") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === unscheduleMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Not found" });
    campaign.status = "draft";
    campaign.scheduledAt = null;
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign });
  }

  return false;
}
