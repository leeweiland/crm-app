import { readJson } from "./auth_backend.js";
import { PAGE_VISITS_FILE } from "./tracking_backend.js";
import { getContactMessages } from "./message_index.js";

// {{click.first}} / {{click.last}} in a flow: a contact's first and most recent
// tracked click from ANY source -- ad, YouTube, email, text, social -- unlike
// contact.clickIds, which only knows ads and keeps only the newest one.
// Built from what's already recorded: page visits carrying a source tag, the
// contact's own email rows (a click on a link that leaves our site, like a
// YouTube video, never produces a page visit), and saved ad clicks. Hyros
// contacts also carry "@source" tags from before any of this existed.
const SOCIAL_LABELS = { e: "Email", s: "Text", y: "YouTube", f: "Facebook", i: "Instagram", l: "LinkedIn", x: "X", t: "TikTok" };
const EL_PREFIX_LABELS = [[/^(yt|youtube)-/i, "YouTube"], [/^email-/i, "Email"], [/^sms-/i, "Text"], [/^(fb|facebook)-/i, "Facebook"], [/^(ig|instagram)-/i, "Instagram"], [/^(tt|tiktok)-/i, "TikTok"], [/^(li|linkedin)-/i, "LinkedIn"]];
// Security scanners "click" every link within seconds of delivery.
const MACHINE_CLICK_MS = 60 * 1000;
// A person's email click and the page visit it lands on are one click, not two.
const SAME_CLICK_MS = 5 * 60 * 1000;
const AD_PLATFORMS = { meta: "Meta ad", google: "Google ad" };

function sourceFromTag(tag) {
  for (const [re, label] of EL_PREFIX_LABELS) if (re.test(tag)) return `${label}: ${tag.replace(re, "")}`;
  return `Link: ${tag}`;
}

function adLabel(platform, id, info) {
  const base = AD_PLATFORMS[platform];
  if (info?.name) return `${base}: ${[info.name, info.campaign].filter(Boolean).join(" · ")}`;
  return id ? `${base}: ${id}` : base;
}

function visitLabel(v, adInfo) {
  if (v.el) return sourceFromTag(v.el);
  if (!v.search) return null;
  let params;
  try { params = new URLSearchParams(v.search); } catch { return null; }
  const hAdId = params.get("h_ad_id");
  if (hAdId) {
    const platform = params.get("fbc_id") ? "meta" : params.get("gc_id") ? "google" : null;
    return platform ? adLabel(platform, hAdId, adInfo[`${platform}:${hAdId}`]) : `Ad: ${hAdId}`;
  }
  for (const [param, label] of Object.entries(SOCIAL_LABELS)) {
    const val = params.get(param);
    if (val) return sourceFromTag(val).startsWith("Link:") ? `${label}: ${val}` : sourceFromTag(val);
  }
  if (params.get("fbclid")) return AD_PLATFORMS.meta;
  if (params.get("gclid") || params.get("gbraid") || params.get("wbraid")) return AD_PLATFORMS.google;
  return null;
}

function emailClickTouches(contact) {
  const own = new Set([contact.email, ...(contact.altEmails || [])].filter(Boolean).map(e => e.toLowerCase()));
  const touches = [];
  for (const m of getContactMessages(contact.id)) {
    if (m.channel !== "email" || m.direction !== "outbound") continue;
    // A flow's "notify the team" copy sits on the lead's thread too -- staff clicks aren't the lead's.
    if (m.to && own.size && !own.has(String(m.to).toLowerCase())) continue;
    const sentMs = Date.parse(m.createdAt);
    const clicks = (m.statusHistory || []).filter(h => h.status === "clicked").map(h => Date.parse(h.at)).filter(at => at - sentMs >= MACHINE_CLICK_MS);
    if (!clicks.length) continue;
    const label = `Email: ${m.subject || "(no subject)"}`;
    touches.push({ label, at: Math.min(...clicks) }, { label, at: Math.max(...clicks) });
  }
  return touches;
}

function savedAdTouches(saved) {
  if (!saved) return [];
  const at = Date.parse(saved.capturedAt);
  if (isNaN(at)) return [];
  for (const platform of Object.keys(AD_PLATFORMS)) {
    if (saved.ads?.[platform]) return [{ label: adLabel(platform, saved.ads[platform].id, saved.ads[platform]), at }];
  }
  if (saved.fbclid) return [{ label: AD_PLATFORMS.meta, at }];
  if (saved.gclid || saved.gbraid || saved.wbraid) return [{ label: AD_PLATFORMS.google, at }];
  return [];
}

// Hyros recorded which sources but not in what order, so these are listed
// together and dated by when the contact became a lead.
function hyrosSources(contact) {
  if (!contact.tags?.length) return null;
  const names = new Map(readJson("crm_tags.json", []).filter(t => String(t.name || "").length > 1 && t.name[0] === "@").map(t => [t.id, t.name.slice(1)]));
  const sources = contact.tags.map(id => names.get(id)).filter(Boolean);
  if (!sources.length) return null;
  const m = contact.source === "hyros_import" ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(String(contact.firstSeenAt || "")) : null;
  const at = m ? Date.parse(m[1] + "Z") : Date.parse(contact.createdAt);
  const shown = sources.slice(0, 3).join(", ") + (sources.length > 3 ? ` +${sources.length - 3} more` : "");
  return { label: `Hyros: ${shown} (order not recorded)`, at };
}

function formatTouch(t) {
  const date = isNaN(t.at) ? "" : new Date(t.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Anchorage" });
  return date ? `${t.label} · ${date}` : t.label;
}

// which: "first" | "last". Never throws into a send -- a notification with
// "Unknown" on one line beats no notification.
export function describeContactClick(contact, which) {
  if (!contact?.id) return "Unknown";
  try {
    const adInfo = Object.fromEntries(Object.entries(readJson("crm_ad_info_cache.json", {})).map(([k, v]) => [k, v.info]));
    const emailClicks = emailClickTouches(contact);
    const visits = readJson(PAGE_VISITS_FILE, []).filter(v => v.contactId === contact.id).flatMap(v => {
      const label = visitLabel(v, adInfo);
      return label ? [{ label: v.inferred ? `${label} (inferred)` : label, at: Date.parse(v.at) }] : [];
    }).filter(t => !(t.label.startsWith("Email:") && emailClicks.some(c => Math.abs(t.at - c.at) <= SAME_CLICK_MS)));
    const touches = [...visits, ...emailClicks, ...savedAdTouches(contact.firstClickIds), ...savedAdTouches(contact.clickIds)].filter(t => !isNaN(t.at)).sort((a, b) => a.at - b.at);
    const hyros = hyrosSources(contact);
    if (which === "first") {
      if (hyros && (!touches.length || hyros.at <= touches[0].at)) return formatTouch(hyros);
      return touches.length ? formatTouch(touches[0]) : "Unknown";
    }
    if (touches.length) return formatTouch(touches[touches.length - 1]);
    return hyros ? formatTouch(hyros) : "Unknown";
  } catch (e) {
    console.error(`[contact_clicks] ${contact.id}:`, e.message);
    return "Unknown";
  }
}
