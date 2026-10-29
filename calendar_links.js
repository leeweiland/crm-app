import { getPublicBaseUrl } from "./integrations_backend.js";

// ── Add-to-calendar links + universal .ics, same shapes as chat-app's ──────
// Shared by bookings (scheduling_backend.js, one link set per booking) and
// campaigns (one event for every recipient -- see campaignCalendarLinks).
function icsDate(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function icsEscape(s) { return String(s || "").replace(/[\\,;]/g, m => "\\" + m).replace(/\n/g, "\\n"); }
export function buildGoogleCalendarLink({ summary, description, start, end, timezone, location }) {
  const params = new URLSearchParams({ action: "TEMPLATE", text: summary, details: description || "", dates: `${icsDate(start)}/${icsDate(end)}`, ctz: timezone });
  if (location) params.set("location", location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
export function buildOutlookCalendarLink({ summary, description, start, end, location }) {
  const params = new URLSearchParams({ path: "/calendar/action/compose", rru: "addevent", subject: summary, body: description || "", startdt: start.toISOString(), enddt: end.toISOString() });
  if (location) params.set("location", location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}
export function buildIcs({ summary, description, start, end, uid, location }) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pacific Rim Athletics//CRM Scheduling//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${uid}@pacificrimathletics.com`, `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEscape(summary)}`, `DESCRIPTION:${icsEscape(description)}`,
    ...(location ? [`LOCATION:${icsEscape(location)}`] : []),
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}

// A campaign's calendarEvent is {title, startAt (ISO), durationMin,
// timezone, location} -- one event for the whole send (a Zoom open house,
// a live class), unlike a booking's per-contact time. Null when no start
// is set, so callers can tell "no event" apart from a real one.
export function campaignEventDetails(campaign) {
  const ev = campaign?.calendarEvent;
  const start = ev?.startAt ? new Date(ev.startAt) : null;
  if (!start || isNaN(start)) return null;
  const end = new Date(start.getTime() + (Number(ev.durationMin) || 60) * 60000);
  const summary = ev.title || campaign.subject || "Event";
  const location = ev.location || "";
  const description = location ? `${summary}\n\nJoin here: ${location}` : summary;
  return { summary, description, start, end, location, timezone: ev.timezone || "UTC", uid: `campaign-${campaign.id}` };
}

export function campaignCalendarLinks(campaign) {
  const d = campaignEventDetails(campaign);
  if (!d) return null;
  return {
    addToCalendarGoogle: buildGoogleCalendarLink(d),
    addToCalendarOutlook: buildOutlookCalendarLink(d),
    addToCalendarApple: `${getPublicBaseUrl()}/api/campaigns/${campaign.id}/event.ics`,
  };
}

const CALENDAR_TOKEN_RE = /%ADDTOCALENDAR(GOOGLE|OUTLOOK|APPLE)%/i;
export function blocksUseCalendarTokens(blocks) {
  return (blocks || []).some(b => CALENDAR_TOKEN_RE.test(b.html || "") || CALENDAR_TOKEN_RE.test(b.link || ""));
}

// Same token names the booking emails use, resolved against the campaign's
// own event -- text blocks (the Personalize-inserted buttons) and button
// block links alike.
export function applyCalendarLinksToBlocks(blocks, links) {
  if (!links) return blocks;
  const sub = (s) => String(s)
    .replace(/%ADDTOCALENDARGOOGLE%/gi, links.addToCalendarGoogle)
    .replace(/%ADDTOCALENDAROUTLOOK%/gi, links.addToCalendarOutlook)
    .replace(/%ADDTOCALENDARAPPLE%/gi, links.addToCalendarApple);
  return (blocks || []).map(b => {
    const out = { ...b };
    if (typeof b.html === "string") out.html = sub(b.html);
    if (typeof b.link === "string") out.link = sub(b.link);
    return out;
  });
}
