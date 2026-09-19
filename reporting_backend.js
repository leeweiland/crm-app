import { readJson, sendJson, getSessionUser, isAdmin, USERS_FILE, sortByName } from "./auth_backend.js";
import { getMessagesForSource } from "./message_log.js";
import { getDailyStatsInRange, getContactMessages } from "./message_index.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";
import { AUTOMATIONS_FILE } from "./automations_backend.js";
import { WORKFLOWS_FILE } from "./workflows_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { PAGE_VISITS_FILE } from "./tracking_backend.js";
import { BOOKINGS_FILE } from "./scheduling_backend.js";
import { sentCategoryForSourceType, SENT_CATEGORIES } from "./ai_agents_backend.js";
import { fetchLiveMetaAdLevel, fetchLiveGoogleAdLevel, fetchCrmLeadsAndBookings, anchorageMidnightUTC, crmEventRuns } from "./ads_backend.js";
import { getCachedTestContactIds, TAGS_FILE } from "./contacts_backend.js";
import { getContactByIdFast, getContactsByIdsFast } from "./sqlite_inbox.js";
import { isYouTubeVideoId, lookupVideoTitles } from "./youtube_backend.js";

// Cross-channel dashboards -- these used to read crm_message_log.json
// directly (12+GB and growing; a full scan blocks the whole single-threaded
// server for however long it takes -- see message_log.js's postmortem
// comment). getDailyStatsInRange reads a small per-day running-count index
// instead (message_index.js), updated incrementally at send/webhook time --
// same "keep it small, update it as you go" pattern as msg_by_source below.
// These helpers turn a day-bucket's (or several summed together) CURRENT-
// status counts into the same {sent,delivered,opened,...} shape the old
// per-message fold produced -- e.g. "sent" = however many messages are
// currently sitting at sent-or-later, since status only ever moves forward.
// Still used by the per-source endpoints below (getMessagesForSource
// returns real slim message rows, not pre-aggregated counts).
function statsFromMessages(messages) {
  const stats = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, failed: 0 };
  for (const m of messages) {
    if (["sent", "delivered", "opened", "clicked"].includes(m.status)) stats.sent++;
    if (["delivered", "opened", "clicked"].includes(m.status)) stats.delivered++;
    if (["opened", "clicked"].includes(m.status)) stats.opened++;
    if (m.status === "clicked") stats.clicked++;
    if (m.status === "bounced") stats.bounced++;
    if (m.status === "complained") stats.complained++;
    if (m.status === "failed") stats.failed++;
  }
  return stats;
}
function smsStatsFromMessages(messages) {
  const stats = { sent: 0, delivered: 0, failed: 0, received: 0 };
  for (const m of messages) {
    if (m.direction === "inbound") { stats.received++; continue; }
    if (["queued", "sent", "delivered"].includes(m.status)) stats.sent++;
    if (m.status === "delivered") stats.delivered++;
    if (m.status === "failed") stats.failed++;
  }
  return stats;
}
function statsFromByStatus(byStatus, receivedCount) {
  const c = (statuses) => statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
  return {
    sent: c(["sent", "delivered", "opened", "clicked"]),
    delivered: c(["delivered", "opened", "clicked"]),
    opened: c(["opened", "clicked"]),
    clicked: c(["clicked"]),
    bounced: c(["bounced"]),
    complained: c(["complained"]),
    failed: c(["failed"]),
    received: receivedCount || 0,
  };
}
function smsStatsFromByStatus(byStatus, receivedCount) {
  const c = (statuses) => statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
  return { sent: c(["queued", "sent", "delivered"]), delivered: c(["delivered"]), failed: c(["failed"]), received: receivedCount || 0 };
}
function sumByStatus(days, key) {
  return days.reduce((acc, d) => { for (const [s, n] of Object.entries(d[key] || {})) acc[s] = (acc[s] || 0) + n; return acc; }, {});
}

// Same testContact exclusion as message_index.js's daily-stats recording
// (see recordDailyStatsNew there) -- a contact flagged testContact
// (contact-detail.html's "Test Contact" checkbox) shouldn't skew these
// per-campaign/automation/workflow stats either, for the same reason.
function excludeTestContacts(messages) {
  // Was its own full readJson(CONTACTS_FILE, []) (~181MB, never cached on
  // the live server by design -- see auth_backend.js) on every single call.
  // Confirmed live as the dominant cost of the Email Campaigns list page:
  // one of these fires per campaign row, so 8 campaigns on screen meant 8
  // full-file streams. contacts_backend.js's counts cache already computes
  // this same set every refresh for its own purposes; reused here instead.
  // Falls back to computing live only on a cold start, before the
  // scheduler's first tick has populated that cache yet.
  const cached = getCachedTestContactIds();
  const testIds = new Set(cached ?? readJson(CONTACTS_FILE, []).filter(c => c.testContact).map(c => c.id));
  return messages.filter(m => !testIds.has(m.contactId));
}

// Aggregate Sent/Opened/Clicked across every campaign (or every automation
// step) at once, filtered to the selected range -- same per-source-file
// reads the single-campaign/automation report pages already use (see
// getMessagesForSource's own comment on why this is never a message-log
// scan), just summed across all of them instead of one at a time.
function statsFromSources(sourceType, sourceIds, startMs, endMs, statsFn) {
  const messages = sourceIds.flatMap(id => excludeTestContacts(getMessagesForSource(sourceType, id)))
    .filter(m => { const t = new Date(m.sentAt || 0).getTime(); return t >= startMs && t <= endMs; });
  return { stats: (statsFn || statsFromMessages)(messages), messages };
}

// "Reply" = a contact who received one of these sends wrote back
// afterward. Two things confirmed live as necessary, not optional: an
// inbound message only counts if it landed AFTER that contact's own
// (earliest in-range) send -- otherwise an unrelated inbound email from
// earlier the same day counted as a "reply" to a send it predates -- and
// at most ONE reply per contact, not one per inbound message -- otherwise
// a single back-and-forth conversation with one contact could inflate
// Replies past the number of people actually reached, or even past Sent
// itself (confirmed live: 17 sent showed 20 replies before this fix).
function countReplies(sentMessages, channel, endMs) {
  const earliestSendByContact = new Map();
  const providerIdsByContact = new Map();
  for (const m of sentMessages) {
    if (!m.contactId) continue;
    const t = new Date(m.sentAt || 0).getTime();
    const existing = earliestSendByContact.get(m.contactId);
    if (existing === undefined || t < existing) earliestSendByContact.set(m.contactId, t);
    if (m.providerMessageId) {
      if (!providerIdsByContact.has(m.contactId)) providerIdsByContact.set(m.contactId, []);
      providerIdsByContact.get(m.contactId).push(m.providerMessageId);
    }
  }
  let replies = 0;
  for (const [contactId, sentAtMs] of earliestSendByContact) {
    // Precise match first: In-Reply-To/References (see gmail_backend.js's
    // processGmailMessage) names the exact provider message id this is
    // replying to -- checked as a substring, not exact equality, since SES
    // wraps its own MessageId in a <...@region.amazonses.com> envelope we
    // don't reconstruct ourselves, but the raw id still appears verbatim
    // inside it either way. Only sends logged after this field started
    // being captured carry a providerMessageId here (getMessagesForSource
    // reads whatever's actually on disk -- nothing retroactive), so this
    // silently has nothing to match for older sends; falls through to the
    // timing heuristic below for exactly those, not a hard requirement.
    const providerIds = providerIdsByContact.get(contactId) || [];
    const contactMessages = getContactMessages(contactId);
    const preciseMatch = providerIds.length && contactMessages.some(m =>
      m.channel === channel && m.direction === "inbound" && m.inReplyTo && providerIds.some(pid => m.inReplyTo.includes(pid))
    );
    if (preciseMatch) { replies++; continue; }
    // Fallback: same contact, same channel, inbound after their earliest
    // in-range send -- a timing guess, not a verified thread link (see the
    // conversation with the user this was written for: it can miscount an
    // unrelated inbound message as a "reply").
    const timingMatch = contactMessages.some(m => {
      if (m.channel !== channel || m.direction !== "inbound") return false;
      const t = new Date(m.createdAt).getTime();
      return t > sentAtMs && t <= endMs;
    });
    if (timingMatch) replies++;
  }
  return replies;
}
function automationStepSourceIds(automation) {
  return Object.keys(automation.steps || {}).map(stepId => `${automation.id}:${stepId}`);
}
function workflowStepSourceIds(workflow) {
  return (workflow.steps || []).map(s => `${workflow.id}:${s.id}`);
}

// Click-to-conversion attribution, grouped by the el= source tag every
// tracked link (email/SMS/ads/social, see source_names.js and the Ad
// Platform Link Tracking settings) already carries. Distinct from the
// existing "Ads" tab, which shows ad SPEND pulled from a Google Sheet --
// this is CONVERSION data derived entirely from this app's own
// crm_page_visits.json (see tracking_backend.js) and crm_contacts.json,
// no external source.
//
// First-touch attribution: each contact is credited to the el= value of
// their EARLIEST el=-tagged page visit (any time, not bounded by the
// selected date range -- their true first touch might predate it), then
// only counted if their OWN conversion event (opt-in = contact.createdAt,
// booking = an actual crm_bookings.json row, enrolled = current status)
// falls inside the selected range. Visit/unique-visitor counts, separately,
// are bounded by the range directly (how much traffic each source drove
// in this window, identified or not).
// A page visit's attribution key: el= (every link this CRM itself sends --
// email/SMS/campaigns/automations -- gets one automatically) if present,
// otherwise whatever the AD PLATFORM'S OWN tracking template put on the
// URL. Confirmed live (2026-09-03) against this account's actual Meta ad
// template (Settings -> Ad Platform Link Tracking): real ad clicks never
// carry el= at all, they carry fbc_id/h_ad_id (or gc_id/h_ad_id for
// Google) instead -- h_ad_id is the one field both this account's
// templates share, by design, so it's the fallback grouping key. Prefixed
// by platform (meta-ad/google-ad) when the platform-specific id is also
// present, so the two don't collide if the same numeric ad id somehow
// existed on both platforms. Falls back to raw ad:<id> if h_ad_id shows up
// with neither fbc_id nor gc_id (a template someone typo'd, or a future
// platform not accounted for here yet). Labels are the ad platform's own
// numeric ids, not human-readable names -- there's no lookup back to "what
// this ad was called" without pulling that from Meta/Google's own APIs,
// a separate integration this doesn't attempt.
// Single-letter shorthand params -- for contexts where a long el=
// descriptive tag isn't practical (an Instagram/TikTok bio link, a
// character-capped Twitter/X post, a YouTube description line). Checked
// only after el= and the ad-platform h_ad_id fallback, since those are
// this app's primary conventions -- these are additional, not a
// replacement.
const SOCIAL_PARAM_PLATFORM = { e: "email", s: "sms", y: "youtube", f: "facebook", i: "instagram", l: "linkedin", x: "twitter", t: "tiktok" };
function attributionKeyForVisit(v) {
  if (v.el) return v.el;
  if (!v.search) return null;
  let params;
  try { params = new URLSearchParams(v.search); } catch { return null; }
  const hAdId = params.get("h_ad_id");
  if (hAdId) {
    if (params.get("fbc_id")) return `meta-ad:${hAdId}`;
    if (params.get("gc_id")) return `google-ad:${hAdId}`;
    return `ad:${hAdId}`;
  }
  for (const [param, platform] of Object.entries(SOCIAL_PARAM_PLATFORM)) {
    const val = params.get(param);
    if (val) return `${platform}:${val}`;
  }
  return null;
}

export function computeAttribution(startMs, endMs) {
  // Same testContact exclusion as excludeTestContacts above -- this
  // report's own numbers would otherwise get real click/opt-in counts
  // muddied by whoever's own test contact (e.g. sending themselves test
  // links while building/verifying this exact feature).
  const contacts = readJson(CONTACTS_FILE, []).filter(c => !c.testContact);
  const contactsById = new Map(contacts.map(c => [c.id, c]));
  const visits = readJson(PAGE_VISITS_FILE, []);
  const bookedContactIds = new Set(readJson(BOOKINGS_FILE, []).map(b => b.contactId));

  const visitStats = new Map(); // key -> {visits, visitorIds:Set}
  const firstTouchByContact = new Map(); // contactId -> {key, atMs}
  for (const v of visits) {
    const key = attributionKeyForVisit(v);
    if (!key) continue;
    const atMs = new Date(v.at).getTime();
    if (atMs >= startMs && atMs <= endMs) {
      if (!visitStats.has(key)) visitStats.set(key, { visits: 0, visitorIds: new Set() });
      const s = visitStats.get(key);
      s.visits++;
      if (v.visitorId) s.visitorIds.add(v.visitorId);
    }
    if (v.contactId) {
      const existing = firstTouchByContact.get(v.contactId);
      if (!existing || atMs < existing.atMs) firstTouchByContact.set(v.contactId, { key, atMs, inferred: !!v.inferred });
    }
  }

  // byElStage powers the drill-down endpoint -- "key|stage" -> Set(contactId).
  // Keyed by the same attributionKeyForVisit value as everything else here
  // (el=, or the meta-ad:/google-ad:/ad: fallback) -- "el" in the name is
  // legacy from before the fallback existed, kept as-is rather than
  // renaming every call site for a label that's still accurate for the
  // common case (this CRM's own sent links).
  const byElStage = new Map();
  function addToStage(key, stage, contactId) {
    const k = `${key}|${stage}`;
    if (!byElStage.has(k)) byElStage.set(k, new Set());
    byElStage.get(k).add(contactId);
  }
  const conversionStats = new Map(); // key -> {optIns, bookings, enrolled}
  for (const [contactId, touch] of firstTouchByContact) {
    const contact = contactsById.get(contactId);
    if (!contact) continue;
    const createdMs = new Date(contact.createdAt).getTime();
    if (createdMs < startMs || createdMs > endMs) continue; // opt-in itself didn't happen in this window
    if (!conversionStats.has(touch.key)) conversionStats.set(touch.key, { optIns: 0, bookings: 0, enrolled: 0 });
    const c = conversionStats.get(touch.key);
    c.optIns++;
    addToStage(touch.key, "optIns", contactId);
    if (bookedContactIds.has(contactId)) { c.bookings++; addToStage(touch.key, "bookings", contactId); }
    if (contact.status === "ENROLLED") { c.enrolled++; addToStage(touch.key, "enrolled", contactId); }
  }

  // Hyros source tags. Every contact already carries the "@tag" for each source Hyros
  // tracked for them, and a tag minus its "@" is the same key as an el= tag
  // (@yt-5moves -> yt-5moves, @email-foo -> email-foo), so they're used as they are: a
  // contact counts under each source tag it has, dated by their own Hyros first-seen date
  // (an imported contact's createdAt is just the import date -- createdAt itself is not
  // touched). A contact with a live tracked touch keeps that instead.
  const hyrosStats = new Map(), hyrosByStage = new Map();
  const hyrosUnique = { optIns: 0, bookings: 0, enrolled: 0, customers: 0, revenue: 0 }; // each contact once, however many source tags
  const tagInfo = hyrosTagInfo();
  if (tagInfo.sourceKeyById.size) {
    const addHy = (key, stage, id) => { const k = `${key}|${stage}`; if (!hyrosByStage.has(k)) hyrosByStage.set(k, new Set()); hyrosByStage.get(k).add(id); };
    for (const c of contacts) {
      const imported = c.source === "hyros_import";
      if (firstTouchByContact.has(c.id) || (!imported && !c.tags?.length)) continue;
      let keys = null;
      for (const id of c.tags || []) { const k = tagInfo.sourceKeyById.get(id); if (k) (keys ||= new Set()).add(k); }
      // A Hyros contact with no source tag (some bought without one) still counts, in its own row, so totals stay complete.
      if (!keys) { if (!imported) continue; keys = new Set([HYROS_NO_SOURCE]); }
      const leadMs = hyrosLeadMs(c);
      if (!(leadMs >= startMs && leadMs <= endMs)) continue;
      const ctags = c.tags || [];
      const booked = bookedContactIds.has(c.id) || ctags.some(id => tagInfo.bookedIds.has(id));
      const enrolled = c.status === "ENROLLED" || ctags.some(id => tagInfo.purchaseIds.has(id));
      // Revenue: add up the dollar amounts in the contact's own $ purchase tags ($stripe-2000, $pra-...-pif-3800).
      let revenue = 0;
      for (const id of ctags) revenue += tagInfo.amountById.get(id) || 0;
      hyrosUnique.optIns++;
      if (booked) hyrosUnique.bookings++;
      if (enrolled) hyrosUnique.enrolled++;
      if (revenue > 0) { hyrosUnique.customers++; hyrosUnique.revenue += revenue; }
      for (const key of keys) {
        if (!hyrosStats.has(key)) hyrosStats.set(key, { optIns: 0, bookings: 0, enrolled: 0, revenue: 0, customers: 0 });
        const s = hyrosStats.get(key);
        s.optIns++; addHy(key, "optIns", c.id);
        if (booked) { s.bookings++; addHy(key, "bookings", c.id); }
        if (enrolled) { s.enrolled++; addHy(key, "enrolled", c.id); }
        if (revenue > 0) { s.revenue += revenue; s.customers++; }
      }
    }
  }

  const allKeys = new Set([...visitStats.keys(), ...conversionStats.keys(), ...hyrosStats.keys()]);
  const sources = [...allKeys].map(key => {
    const vs = visitStats.get(key) || { visits: 0, visitorIds: new Set() };
    const cs = conversionStats.get(key) || { optIns: 0, bookings: 0, enrolled: 0 };
    const hs = hyrosStats.get(key);
    return {
      el: key, visits: vs.visits, uniqueVisitors: vs.visitorIds.size, optIns: cs.optIns, bookings: cs.bookings, enrolled: cs.enrolled,
      // Hyros counts kept separate from the live ones (the Ads Report adds them to its own event-based counts)
      hyrosOptIns: hs?.optIns || 0, hyrosBookings: hs?.bookings || 0, hyrosEnrolled: hs?.enrolled || 0,
      hyrosRevenue: hs?.revenue || 0, hyrosCustomers: hs?.customers || 0,
      hyrosOnly: !visitStats.has(key) && !conversionStats.has(key),
    };
  }).sort((a, b) => b.visits - a.visits);

  return { sources, byElStage, hyrosByStage, hyrosUnique, hyrosSourceCount: hyrosStats.size, firstTouchByContact, contactsById };
}

// Which tags are Hyros source tags ("@..."), booking tags ("$call"/"$application"), and
// purchase tags (any other "$..."), by tag id -- read from the tags list every contact's
// tags point into.
function hyrosTagInfo() {
  const sourceKeyById = new Map(), bookedIds = new Set(), purchaseIds = new Set(), amountById = new Map();
  for (const t of readJson(TAGS_FILE, [])) {
    const n = String(t.name || "");
    if (n.length > 1 && n[0] === "@") sourceKeyById.set(t.id, n.slice(1));
    else if (n === "$call" || n === "$application") bookedIds.add(t.id);
    else if (n[0] === "$" && n !== "$examplesale") {
      purchaseIds.add(t.id);
      // The price is the tag's trailing number ($stripe-2000, $pra-online-single-4-mo-pif-3800); $sale/$gym/$paypal have none.
      const m = /-(\d+)$/.exec(n);
      if (m) amountById.set(t.id, Number(m[1]));
    }
  }
  return { sourceKeyById, bookedIds, purchaseIds, amountById };
}
// When a Hyros-imported contact became a lead: their firstSeenAt clock digits read as UTC (the
// import stamped a wrong -09:00 offset on it). Everyone else: createdAt, as always.
function hyrosLeadMs(c) {
  if (c.source === "hyros_import") {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(String(c.firstSeenAt || ""));
    if (m) return Date.parse(m[1] + "Z");
  }
  return new Date(c.createdAt).getTime();
}
const HYROS_NO_SOURCE = "hyros-no-source";
const HYROS_NOTE ="Includes Hyros source tags: a contact counts under every source tag it carries (so rows overlap), dated by their Hyros first-seen date. Revenue is estimated from each contact's $ purchase tags -- in a test against recorded Hyros sales it came to about 82% of actual payments (never over), and refunds aren't reflected.";

// A contact's first ad/source touch, for crediting their conversion events.
// 1) the earliest tagged visit linked to them (the real click journey), else
// 2) the click data stamped on the contact when they signed up (flows_backend.js's
// add_update_contact: the ad's own id when the URL carried it, else just the
// platform's click id). Null = nothing was ever captured -> "Untracked".
function touchKeyForContact(contact, firstTouchByContact) {
  const visitTouch = firstTouchByContact.get(contact.id);
  if (visitTouch?.key) return visitTouch.key;
  const ids = contact.clickIds;
  if (!ids) return null;
  if (ids.ads?.meta?.id) return `meta-ad:${ids.ads.meta.id}`;
  if (ids.ads?.google?.id) return `google-ad:${ids.ads.google.id}`;
  if (ids.fbclid) return "meta-ad:unknown";
  if (ids.gclid || ids.gbraid || ids.wbraid) return "google-ad:unknown";
  return null;
}
// Every conversion EVENT in the range (ONLINE/GYM EMAIL, ONLINE BOOKING, GYM
// APPLICATION -- one per flow run, see ads_backend.js's crmEventRuns), credited to
// the source of the contact's first touch. bySource: key -> {emails, bookings};
// byKeyStage: "key|optIns" / "key|bookings" -> Set(contactId) for the drill-down.
export function computeEventAttribution(startStr, endStr, attribution) {
  const crmStartMs = anchorageMidnightUTC(startStr).getTime();
  const crmEndMs = anchorageMidnightUTC(endStr).getTime() + 86400000 - 1;
  const { firstTouchByContact, contactsById } = attribution;
  const bySource = new Map(), byKeyStage = new Map();
  const attributed = { online: { emails: 0, bookM: 0 }, gym: { emails: 0, bookM: 0 } };
  let inferred = 0; // credited via a timing-inferred link (attribution_backfill.js), not a recorded sign-up beacon
  for (const ev of crmEventRuns(crmStartMs, crmEndMs)) {
    const contact = ev.contactId ? contactsById.get(ev.contactId) : null;
    const key = contact ? touchKeyForContact(contact, firstTouchByContact) : null;
    if (!key) continue;
    if (!bySource.has(key)) bySource.set(key, { emails: 0, bookings: 0 });
    const s = bySource.get(key);
    const stage = ev.kind === "emails" ? "optIns" : "bookings";
    if (stage === "optIns") s.emails++; else s.bookings++;
    attributed[ev.program][ev.kind]++;
    if (firstTouchByContact.get(contact.id)?.inferred) inferred++;
    const k = `${key}|${stage}`;
    if (!byKeyStage.has(k)) byKeyStage.set(k, new Set());
    byKeyStage.get(k).add(ev.contactId);
  }
  return { bySource, byKeyStage, attributed, inferred };
}

function slugify(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
}
// Hyphens/underscores -> spaces, each word capitalized -- "3-day-vsl-promo"
// reads as "3 Day Vsl Promo". Numeric ad IDs pass through unchanged (no
// word boundaries to fix), which is the honest fallback when Meta/Google
// insights didn't resolve a real ad name for that id.
function niceTitle(raw) {
  const s = String(raw || "").trim();
  if (!s) return s;
  return s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase());
}
// Reverse-maps an el=email-<slug>/sms-<slug> tag back to the campaign/
// automation/workflow's CURRENT name, by slugifying every current name the
// same way resolveSendSourceSlug does at send time and matching against
// it. Approximate by nature -- a source renamed since it sent won't match
// its own historical el= tags anymore -- but exact for the common case
// (most aren't renamed), with no per-send historical name to fall back on.
function buildSlugNameIndex() {
  const idx = new Map();
  for (const c of readJson(CAMPAIGNS_FILE, [])) idx.set(slugify(c.name), c.name);
  for (const a of readJson(AUTOMATIONS_FILE, [])) idx.set(slugify(a.name), a.name);
  for (const w of readJson(WORKFLOWS_FILE, [])) idx.set(slugify(w.name), w.name);
  return idx;
}
const SOCIAL_PLATFORM_LABEL = { email: "Email", sms: "SMS", youtube: "YouTube", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", twitter: "Twitter", tiktok: "TikTok" };
// Turns one attribution key into {title, adGroup, campaign, spend,
// platform} for the Ads Report table -- title is always something a
// human can read, adGroup/campaign are "—" when that hierarchy genuinely
// doesn't apply (an email/SMS/social source isn't inside a Meta ad set or
// Google ad group), not when data is merely missing.
function sourceMeta(key, metaAdMap, googleAdMap, slugIndex) {
  if (key === HYROS_NO_SOURCE) return { title: "No source tag (Hyros)", adGroup: "—", campaign: "—", spend: 0, platform: "Hyros" };
  if (key === "meta-ad:unknown") return { title: "Meta ad (ad ID not captured)", adGroup: "—", campaign: "—", spend: 0, platform: "Meta" };
  if (key === "google-ad:unknown") return { title: "Google ad (ad ID not captured)", adGroup: "—", campaign: "—", spend: 0, platform: "Google" };
  if (key.startsWith("meta-ad:")) {
    const id = key.slice(8);
    const info = metaAdMap?.get(id);
    return { title: info?.name || id, adGroup: info?.adGroup || "—", campaign: info?.campaign || "—", spend: info?.spend || 0, platform: "Meta" };
  }
  if (key.startsWith("google-ad:")) {
    const id = key.slice(10);
    const info = googleAdMap?.get(id);
    return { title: info?.name || id, adGroup: info?.adGroup || "—", campaign: info?.campaign || "—", spend: info?.spend || 0, platform: "Google" };
  }
  if (key.startsWith("ad:")) {
    return { title: key.slice(3), adGroup: "—", campaign: "—", spend: 0, platform: "Ad" };
  }
  if (key.startsWith("email-") || key.startsWith("sms-")) {
    const isEmail = key.startsWith("email-");
    const slug = key.slice(isEmail ? 6 : 4);
    return { title: niceTitle(slug), adGroup: "—", campaign: slugIndex.get(slug) || "—", spend: 0, platform: isEmail ? "Email" : "SMS" };
  }
  const socialMatch = key.match(/^(email|sms|youtube|facebook|instagram|linkedin|twitter|tiktok):(.+)$/);
  if (socialMatch) {
    const [, platform, val] = socialMatch;
    return { title: niceTitle(val), adGroup: "—", campaign: "—", spend: 0, platform: SOCIAL_PLATFORM_LABEL[platform] };
  }
  return { title: niceTitle(key), adGroup: "—", campaign: "—", spend: 0, platform: "Other" };
}

// Ad Attribution's raw tags -> readable rows: an ad ID becomes the ad's own
// name with its ad set/group and campaign, and a YouTube video ID (from y=<id>
// or the tail of an el=yt-<name>-<id> tag) becomes the video's title. Same
// lookups as the Ads Report; anything unresolvable keeps the prettified tag,
// and the raw tag always stays visible in the UI.
const YT_TAG_ID = /^yt-(?:.+-)?([A-Za-z0-9_-]{11})$/;
async function labelAttributionSources(keys, startStr, endStr) {
  const [metaS, googleS] = await Promise.allSettled([
    keys.some(k => k.startsWith("meta-ad:")) ? fetchLiveMetaAdLevel(startStr, endStr) : null,
    keys.some(k => k.startsWith("google-ad:")) ? fetchLiveGoogleAdLevel(startStr, endStr) : null,
  ]);
  const metaAdMap = metaS.status === "fulfilled" ? metaS.value : null;
  const googleAdMap = googleS.status === "fulfilled" ? googleS.value : null;
  const slugIndex = buildSlugNameIndex();
  const videoIdOf = (k) => k.startsWith("youtube:") ? k.slice(8) : YT_TAG_ID.exec(k)?.[1] || null;
  const titles = await lookupVideoTitles(keys.map(videoIdOf).filter(Boolean));
  const out = new Map();
  for (const key of keys) {
    const m = sourceMeta(key, metaAdMap, googleAdMap, slugIndex);
    let { title, platform } = m;
    if (key.startsWith("yt-")) { platform = "YouTube"; title = titles.get(videoIdOf(key)) || niceTitle(key.slice(3)); }
    else if (key.startsWith("youtube:")) title = titles.get(videoIdOf(key)) || title;
    out.set(key, { label: title, platform, adGroup: m.adGroup, campaign: m.campaign });
  }
  return out;
}

const money = (n) => (n && isFinite(n)) ? Math.round(n * 100) / 100 : null;
// Combines computeAttribution's real lead/booking counts (per source) with
// ad-hierarchy names and per-ad spend from Meta/Google's own APIs. Revenue/
// Sales/$-per-Sale are placeholders (0/null) until a real sales data
// source is connected -- not computed from anything today, deliberately,
// rather than showing a number that would just be wrong.
export async function computeAdsReport(startMs, endMs, startStr, endStr) {
  const attribution = computeAttribution(startMs, endMs);
  const { sources: visitSources } = attribution;
  const ev = computeEventAttribution(startStr, endStr, attribution);
  // One row per source that either got visits or converted -- visits/unique visitors from
  // the tracked page-visit log, Emails/Bookings from the four conversion events above.
  const sources = [...new Set([...visitSources.map(s => s.el), ...ev.bySource.keys()])].map(el => {
    const vs = visitSources.find(s => s.el === el);
    const e = ev.bySource.get(el) || { emails: 0, bookings: 0 };
    // + the Hyros source tags' counts (contacts carrying that tag, see computeAttribution)
    return { el, visits: vs?.visits || 0, uniqueVisitors: vs?.uniqueVisitors || 0, optIns: e.emails + (vs?.hyrosOptIns || 0), bookings: e.bookings + (vs?.hyrosBookings || 0), revenue: vs?.hyrosRevenue || 0, sales: vs?.hyrosCustomers || 0, hyrosOnly: !!vs?.hyrosOnly };
  }).sort((a, b) => b.visits - a.visits);
  const [metaSettled, googleSettled] = await Promise.allSettled([
    fetchLiveMetaAdLevel(startStr, endStr),
    fetchLiveGoogleAdLevel(startStr, endStr),
  ]);
  const metaAdMap = metaSettled.status === "fulfilled" ? metaSettled.value : null;
  const googleAdMap = googleSettled.status === "fulfilled" ? googleSettled.value : null;
  const spendError = [metaSettled, googleSettled].find(s => s.status === "rejected")?.reason?.message || null;
  const slugIndex = buildSlugNameIndex();

  const rows = sources.map(s => {
    const meta = sourceMeta(s.el, metaAdMap, googleAdMap, slugIndex);
    return {
      source: meta.title, platform: s.hyrosOnly && meta.platform === "Other" ? "Hyros" : meta.platform, adGroup: meta.adGroup, campaign: meta.campaign,
      leads: s.optIns, costPerLead: s.optIns ? money(meta.spend / s.optIns) : null,
      bookings: s.bookings, costPerBooking: s.bookings ? money(meta.spend / s.bookings) : null,
      // Revenue/Sales come only from Hyros purchase tags (customers carrying this source tag, and the sum
      // of their tagged purchase amounts); live rows have no sales source yet, so they stay 0.
      revenue: s.revenue, sales: s.sales, costPerSale: s.sales ? money(meta.spend / s.sales) : null,
      spend: money(meta.spend), visits: s.visits, uniqueVisitors: s.uniqueVisitors,
      key: s.el,
    };
  });
  // A y=<video id> tag is labelled with the video's real title (unresolvable
  // ones keep the prettified tag).
  const ytTitles = await lookupVideoTitles(rows.filter(r => r.key.startsWith("youtube:")).map(r => r.key.slice(8)));
  for (const r of rows) if (r.key.startsWith("youtube:") && ytTitles.has(r.key.slice(8))) r.source = ytTitles.get(r.key.slice(8));

  // computeAttribution can only ever see leads/bookings tied to a TRACKED
  // PAGE VISIT -- confirmed live this misses most real leads, since native
  // Meta/Google Lead Ads and other webhook-delivered leads never touch
  // this site's tracking script at all (there's no page visit to attribute
  // from). Without this, the table's own totals looked wildly undercounted
  // next to fetchCrmLeadsAndBookings's flow-run-based totals shown
  // elsewhere in Reporting (Overview's Ads cards) -- confirmed live: this
  // table showed a handful of leads per source while Overview correctly
  // showed 300+. Rather than silently hide that gap, it's surfaced as its
  // own explicit row per program.
  // True Anchorage-midnight boundaries, not startMs/endMs's plain UTC-
  // midnight-of-the-date-string -- same fix Overview's fetchAdsReport
  // already applies (see anchorageMidnightUTC in ads_backend.js). Using
  // startMs/endMs directly here undercounted vs. Overview by the
  // Anchorage/UTC offset's worth of flow runs at each boundary.
  const crmStartMs = anchorageMidnightUTC(startStr).getTime();
  const crmEndMs = anchorageMidnightUTC(endStr).getTime() + 86400000 - 1;
  const crmData = fetchCrmLeadsAndBookings(crmStartMs, crmEndMs);
  const attributedLeads = { online: ev.attributed.online.emails, gym: ev.attributed.gym.emails };
  const attributedBookings = { online: ev.attributed.online.bookM, gym: ev.attributed.gym.bookM };
  const untrackedRows = ["online", "gym"].map(program => ({
    source: "Untracked (no site visit or ad click ID)", platform: program === "online" ? "Online" : "Gym",
    adGroup: "—", campaign: "—",
    leads: Math.max(0, crmData[program].emails - attributedLeads[program]), costPerLead: null,
    bookings: Math.max(0, crmData[program].bookM - attributedBookings[program]), costPerBooking: null,
    revenue: 0, sales: 0, costPerSale: null,
    spend: 0, visits: 0, uniqueVisitors: 0,
    key: `untracked-${program}`,
  })).filter(r => r.leads > 0 || r.bookings > 0);

  // How much of the period's conversion events could be tied to an ad/source click at all --
  // the rest ("Untracked") had no click journey captured for that contact.
  const totalEmails = crmData.online.emails + crmData.gym.emails, totalBookings = crmData.online.bookM + crmData.gym.bookM;
  const trackedEmails = attributedLeads.online + attributedLeads.gym, trackedBookings = attributedBookings.online + attributedBookings.gym;
  const coverage = { emails: { total: totalEmails, tracked: Math.min(totalEmails, trackedEmails) }, bookings: { total: totalBookings, tracked: Math.min(totalBookings, trackedBookings) }, inferred: ev.inferred };
  // Rows overlap (a Hyros contact counts under every source tag they carry), so the Totals row uses
  // true one-per-contact figures for the Hyros part instead of adding the rows up.
  const hu = attribution.hyrosUnique;
  const totals = attribution.hyrosSourceCount ? {
    leads: [...ev.bySource.values()].reduce((n, e) => n + e.emails, 0) + untrackedRows.reduce((n, r) => n + r.leads, 0) + hu.optIns,
    bookings: [...ev.bySource.values()].reduce((n, e) => n + e.bookings, 0) + untrackedRows.reduce((n, r) => n + r.bookings, 0) + hu.bookings,
    revenue: hu.revenue, sales: hu.customers,
  } : null;
  return { rows: [...rows, ...untrackedRows], spendError, coverage, totals, hyrosNote: attribution.hyrosSourceCount ? HYROS_NOTE : null };
}

// Shared with ads_backend.js's period presets on the frontend -- the
// frontend resolves a period to concrete start/end dates and passes them
// here directly, so this endpoint just needs a plain date range, not the
// preset logic itself.
function parseRangeParams(url) {
  const endStr = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  const startStr = url.searchParams.get("start") || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  return { startMs: new Date(startStr + "T00:00:00Z").getTime(), endMs: new Date(endStr + "T23:59:59Z").getTime() };
}

function emptySentCounts() {
  const c = { total: 0 };
  for (const cat of SENT_CATEGORIES) c[cat] = 0;
  return c;
}

export async function handleReportingRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/reporting")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/reporting/overview" && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);

    const campaignIds = readJson(CAMPAIGNS_FILE, []).map(c => c.id);
    const campaignData = statsFromSources("campaign", campaignIds, startMs, endMs, statsFromMessages);
    const automationStepIds = readJson(AUTOMATIONS_FILE, []).flatMap(automationStepSourceIds);
    const automationData = statsFromSources("automation_step", automationStepIds, startMs, endMs, statsFromMessages);
    const workflowStepIds = readJson(WORKFLOWS_FILE, []).flatMap(workflowStepSourceIds);
    const workflowData = statsFromSources("workflow_step", workflowStepIds, startMs, endMs, smsStatsFromMessages);

    return sendJson(res, 200, {
      campaigns: { ...campaignData.stats, replies: countReplies(campaignData.messages, "email", endMs) },
      automations: { ...automationData.stats, replies: countReplies(automationData.messages, "email", endMs) },
      workflows: { ...workflowData.stats, replies: countReplies(workflowData.messages, "sms", endMs) },
    });
  }

  // Messages sent per team member's book, split by channel and by who/what
  // actually sent it (human vs AI agent vs SMS sequence vs email automation
  // vs campaign) -- same "human-sent" vs "CRM-sent" distinction the Inbox
  // Activity tab surfaces per-person, just rolled up across the whole team
  // with counts instead of a row-by-row feed. Bounded the same way that
  // endpoint is (inbox_backend.js's /api/inbox/activity): only each user's
  // OWNED_CONTACT_SCAN_CAP most-recently-touched contacts are scanned, so
  // this stays a handful of small per-contact file reads per team member
  // rather than a full message-log scan (see statsFromMessages' comment
  // above on why that's off the table).
  if (p === "/api/reporting/sent-by-user" && req.method === "GET") {
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const { startMs, endMs } = parseRangeParams(url);
    const OWNED_CONTACT_SCAN_CAP = 300;
    const users = sortByName(readJson(USERS_FILE, []).filter((u) => !u.archived));
    const allContacts = readJson(CONTACTS_FILE, []).filter((c) => !c.testContact);
    const rows = users.map((u) => {
      const contacts = allContacts
        .filter((c) => c.ownerId === u.id)
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
        .slice(0, OWNED_CONTACT_SCAN_CAP);
      const email = emptySentCounts();
      const sms = emptySentCounts();
      // Inbound only ever counted from these SAME owned/real contacts --
      // never a raw mailbox/phone-line count, which would pull in whatever
      // unrelated mail a connected inbox happens to receive.
      let emailReceived = 0, smsReceived = 0;
      for (const c of contacts) {
        for (const m of getContactMessages(c.id)) {
          if (m.channel !== "email" && m.channel !== "sms") continue;
          const t = new Date(m.createdAt).getTime();
          if (!(t >= startMs && t <= endMs)) continue;
          if (m.direction === "inbound") { if (m.channel === "email") emailReceived++; else smsReceived++; continue; }
          if (m.direction !== "outbound") continue;
          const cat = sentCategoryForSourceType(m.sourceType);
          // Bulk-migrated history (Close/AC/Hyros) is attributed to whoever
          // owns the contact TODAY, which has nothing to do with who
          // actually sent it back then -- confirmed live this misattributes
          // real activity (e.g. AC was only ever used by one person, but
          // ac_import rows show up under teammates who never touched AC,
          // just because they inherited the contact later). Excluded
          // entirely rather than shown under the wrong name.
          if (cat === "legacy_import") continue;
          const bucket = m.channel === "email" ? email : sms;
          bucket[cat]++;
          bucket.total++;
        }
      }
      return { userId: u.id, name: `${u.first} ${u.last}`.trim(), email, sms, emailReceived, smsReceived, scannedContacts: contacts.length };
    });
    return sendJson(res, 200, { rows, categories: SENT_CATEGORIES });
  }

  if (p === "/api/reporting/email-daily" && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const days = getDailyStatsInRange(startMs, endMs);
    const dayRows = days.map(d => {
      const c = (statuses) => statuses.reduce((sum, s) => sum + (d.emailOut[s] || 0), 0);
      return { date: d.date, sent: c(["sent", "delivered", "opened", "clicked"]), opened: c(["opened", "clicked"]), clicked: c(["clicked"]), bounced: c(["bounced"]), failed: c(["failed"]) };
    });
    return sendJson(res, 200, { days: dayRows, totals: statsFromByStatus(sumByStatus(days, "emailOut")) });
  }
  if (p === "/api/reporting/sms-daily" && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const days = getDailyStatsInRange(startMs, endMs);
    const dayRows = days.map(d => {
      const c = (statuses) => statuses.reduce((sum, s) => sum + (d.smsOut[s] || 0), 0);
      return { date: d.date, sent: c(["queued", "sent", "delivered"]), delivered: c(["delivered"]), received: d.smsInCount || 0, failed: c(["failed"]) };
    });
    const totalSmsIn = days.reduce((sum, d) => sum + (d.smsInCount || 0), 0);
    return sendJson(res, 200, { days: dayRows, totals: smsStatsFromByStatus(sumByStatus(days, "smsOut"), totalSmsIn) });
  }

  if ((p === "/api/reporting/attribution" || p === "/api/reporting/attribution/contacts") && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const data = computeAttribution(startMs, endMs);
    if (p === "/api/reporting/attribution") {
      const start = url.searchParams.get("start"), end = url.searchParams.get("end");
      const labels = await labelAttributionSources(data.sources.map(s => s.el), start, end);
      const sources = data.sources.map(s => {
        const l = labels.get(s.el);
        return {
          ...s, ...l,
          platform: s.hyrosOnly && l.platform === "Other" ? "Hyros" : l.platform,
          optIns: s.optIns + s.hyrosOptIns, bookings: s.bookings + s.hyrosBookings, enrolled: s.enrolled + s.hyrosEnrolled,
          hyros: s.hyrosOptIns > 0,
        };
      });
      return sendJson(res, 200, { sources, hyrosNote: data.hyrosSourceCount ? HYROS_NOTE : null, start, end });
    }
    // Drill-down: the exact contacts behind one source's one funnel stage.
    const el = url.searchParams.get("el");
    const stage = url.searchParams.get("stage"); // "optIns" | "bookings" | "enrolled"
    // basis=events: the Ads Report's own counts (conversion events credited to first touch)
    const eventBasis = url.searchParams.get("basis") === "events";
    const startStr = url.searchParams.get("start") || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const endStr = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
    const bucket = eventBasis ? computeEventAttribution(startStr, endStr, data).byKeyStage.get(`${el}|${stage}`) : data.byElStage.get(`${el}|${stage}`);
    const ids = [...new Set([...(bucket || []), ...(data.hyrosByStage.get(`${el}|${stage}`) || [])])];
    if (!ids.length) return sendJson(res, 200, { contacts: [] });
    // A Hyros source tag can hold thousands of contacts -- list the first 500 and say how many there are.
    const need = new Set(ids.slice(0, 500));
    const list = readJson(CONTACTS_FILE, []).filter(c => need.has(c.id));
    return sendJson(res, 200, { contacts: list, total: ids.length, truncated: ids.length > list.length });
  }

  // One contact's own tracked page visits, formatted as journey-timeline
  // "click" items -- kept separate from inbox_backend.js's /api/inbox/
  // contact/:id (which only ever returns message-log items) rather than
  // widening that endpoint's shape, since Inbox itself has no use for
  // click events and this avoids any risk to that page. No ad-hierarchy
  // lookup here (that's Ads Report's job, and needs a live Meta/Google
  // call) -- a single contact's journey just needs a readable label,
  // reusing niceTitle for that, not a full spend/campaign resolution.
  const journeyClicksMatch = p.match(/^\/api\/reporting\/contact-clicks\/([^/]+)$/);
  if (journeyClicksMatch && req.method === "GET") {
    const contactId = journeyClicksMatch[1];
    const visits = readJson(PAGE_VISITS_FILE, []).filter(v => v.contactId === contactId);
    // The el= tag only carries the sending campaign/automation/flow's NAME
    // (resolveSendSourceSlug, source_names.js -- one slug per flow, not per
    // step), so "Clicked: 2 Online Booking" doesn't say which of that flow's
    // several emails/texts it actually was. For email/sms clicks specifically,
    // correlate against this same contact's own outbound history: the most
    // recent email/sms sent to them at or before the click time is, in
    // practice, almost always the one that link lived in -- gives the real
    // subject line (email) or message text (sms) instead of just the flow
    // name. Fetched once per contact, not once per click.
    // Same internal-staff-notification exclusion as
    // /api/inbox/contact/:id (inbox_backend.js) -- a flow's own "notify the
    // team" copy (sent to lee@/alexis@, not the contact) must never be
    // picked as "the email this contact clicked", or a staff member's own
    // click on their internal alert gets misattributed to the contact.
    const contactForOwnEmails = getContactByIdFast(contactId);
    const ownEmails = contactForOwnEmails ? new Set([contactForOwnEmails.email, ...(contactForOwnEmails.altEmails || [])].filter(Boolean).map(e => e.toLowerCase())) : null;
    const outboundByChannel = { email: [], sms: [] };
    for (const m of getContactMessages(contactId)) {
      if (m.direction !== "outbound" || (m.channel !== "email" && m.channel !== "sms")) continue;
      if (m.channel === "email" && ownEmails?.size && m.to && !ownEmails.has(String(m.to).toLowerCase())) continue;
      outboundByChannel[m.channel].push(m);
    }
    outboundByChannel.email.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    outboundByChannel.sms.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    function closestPriorMessage(channel, atIso) {
      const atMs = new Date(atIso).getTime();
      return outboundByChannel[channel].find(m => new Date(m.createdAt).getTime() <= atMs) || null;
    }
    const siteBaseUrl = (readJson("crm_integrations.json", {}).site?.websiteUrl || "").replace(/\/+$/, "");
    const ytTitles = await lookupVideoTitles(visits.map(attributionKeyForVisit).filter(k => k?.startsWith("youtube:")).map(k => k.slice(8)));
    const clicks = visits.map(v => {
      const key = attributionKeyForVisit(v);
      if (!key) return null;
      const isAd = /^(meta-ad|google-ad|ad):/.test(key);
      const socialMatch = key.match(/^(youtube|facebook|instagram|linkedin|twitter|tiktok):(.+)$/);
      const category = isAd ? "ad" : socialMatch ? "media" : (key.startsWith("email") ? "email" : key.startsWith("sms") ? "sms" : "other");
      const flowName = niceTitle(key.replace(/^(email|sms)[-:]/, ""));
      const sourceMsg = (category === "email" || category === "sms") ? closestPriorMessage(category, v.at) : null;
      // Falls back to the flow-name label when no matching send is found
      // (e.g. the click happened before any tracked send, or the message
      // predates getContactMessages' own history) -- never blank.
      const label = isAd ? `${key.startsWith("meta-ad:") ? "Meta" : key.startsWith("google-ad:") ? "Google" : "Ad"} — ${key.split(":")[1]}`
        : socialMatch ? `${SOCIAL_PLATFORM_LABEL[socialMatch[1]]} — ${(socialMatch[1] === "youtube" && ytTitles.get(socialMatch[2])) || niceTitle(socialMatch[2])}`
        : category === "email" ? `Email: ${sourceMsg?.subject || flowName}`
        : category === "sms" ? `SMS: ${sourceMsg?.body ? sourceMsg.body.slice(0, 60) : flowName}`
        : flowName;
      const fullUrl = (siteBaseUrl ? siteBaseUrl : "") + (v.path || "") + (v.search || "");
      return { at: v.at, path: v.path, fullUrl, key, label: v.inferred ? `${label} (linked by timing)` : label, category, sourceSubject: sourceMsg?.subject || null };
    }).filter(Boolean);
    // The contact's Hyros source tags ("@...") as they're already set on them.
    const tagNames = new Map(readJson(TAGS_FILE, []).map(t => [t.id, t.name]));
    const sourceTags = (contactForOwnEmails?.tags || []).map(id => tagNames.get(id)).filter(n => n && n[0] === "@").sort();
    return sendJson(res, 200, { clicks, sourceTags });
  }

  if (p === "/api/reporting/ads-report" && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const endStr = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
    const startStr = url.searchParams.get("start") || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const { rows, spendError, coverage, totals, hyrosNote } = await computeAdsReport(startMs, endMs, startStr, endStr);
    return sendJson(res, 200, { rows, spendError, coverage, totals, hyrosNote, start: startStr, end: endStr });
  }

  const campaignMatch = p.match(/^\/api\/reporting\/campaigns\/([^/]+)$/);
  if (campaignMatch && req.method === "GET") {
    const messages = excludeTestContacts(getMessagesForSource("campaign", campaignMatch[1]));
    return sendJson(res, 200, { stats: statsFromMessages(messages), messages });
  }

  // Automation email steps log with sourceId "<automationId>:<stepId>" --
  // used to be a prefix-scan over crm_message_log.json (12+GB, blocks the
  // whole single-threaded server for however long that scan takes -- see
  // message_log.js's postmortem comment). The automation's own step list is
  // small and already known, so this just reads each step's own small
  // per-source file (see message_index.js's getSourceMessages) and merges
  // them -- O(this automation's steps), never O(every message ever sent).
  // stepStats is keyed by stepId directly -- getMessagesForSource's rows are
  // deliberately slim (id/contactId/to/status/sentAt, no sourceId; which
  // source they came from is already implicit in which per-source file was
  // read) so the per-step breakdown has to be computed here, server-side,
  // rather than the frontend trying to filter the flat list back apart by a
  // sourceId field that was never on these rows.
  const automationMatch = p.match(/^\/api\/reporting\/automations\/([^/]+)$/);
  if (automationMatch && req.method === "GET") {
    const automation = readJson(AUTOMATIONS_FILE, []).find(a => a.id === automationMatch[1]);
    const stepIds = automation ? Object.keys(automation.steps || {}) : [];
    const stepStats = {};
    const messages = stepIds.flatMap(stepId => {
      const stepMessages = excludeTestContacts(getMessagesForSource("automation_step", `${automationMatch[1]}:${stepId}`));
      stepStats[stepId] = statsFromMessages(stepMessages);
      return stepMessages;
    });
    return sendJson(res, 200, { stats: statsFromMessages(messages), stepStats, messages });
  }

  const workflowMatch = p.match(/^\/api\/reporting\/workflows\/([^/]+)$/);
  if (workflowMatch && req.method === "GET") {
    const workflow = readJson(WORKFLOWS_FILE, []).find(w => w.id === workflowMatch[1]);
    const stepIds = workflow ? (workflow.steps || []).map(s => s.id) : [];
    const messages = excludeTestContacts(stepIds.flatMap(stepId => getMessagesForSource("workflow_step", `${workflowMatch[1]}:${stepId}`)));
    return sendJson(res, 200, { stats: smsStatsFromMessages(messages), messages });
  }

  return false;
}
