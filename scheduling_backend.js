import { randomUUID, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, findContactMatch } from "./segments_shared.js";
import { STATUSES_FILE } from "./statuses_backend.js";
import { logMessage } from "./message_log.js";
import { fireTrigger } from "./automations_backend.js";
import { fireWorkflowTrigger, checkConversionGoal } from "./workflows_backend.js";
import { sendEmail } from "./email_backend.js";
import { sendSms } from "./sms_backend.js";
import { getPublicBaseUrl } from "./integrations_backend.js";
import { fireFlowTrigger } from "./flows_backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const EVENT_TYPES_FILE = "crm_event_types.json";
export const BOOKINGS_FILE = "crm_bookings.json";
export const AVAILABILITY_FILE = "crm_availability.json"; // legacy global availability -- read once to seed the "default" calendar below, never written again
export const TEAM_CALENDARS_FILE = "crm_team_calendars.json"; // legacy flat name+email list -- read once to seed CALENDARS_FILE, never written again
export const CALENDARS_FILE = "crm_calendars.json";

// Availability is per-calendar now, not one global setting -- different
// people (different Google Calendars) have different hours, notice,
// buffers, and how far out they want to take bookings.
const DEFAULT_CALENDAR_AVAILABILITY = {
  timezone: "America/Anchorage",
  minNoticeMinutes: 120,
  // 0 = Sunday ... 6 = Saturday. null = closed that day.
  weekly: {
    "0": null,
    "1": { start: "09:00", end: "17:00" },
    "2": { start: "09:00", end: "17:00" },
    "3": { start: "09:00", end: "17:00" },
    "4": { start: "09:00", end: "17:00" },
    "5": { start: "09:00", end: "17:00" },
    "6": null,
  },
  dateOverrides: {}, // "YYYY-MM-DD": { closed: true }
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  // "days": show every open slot in the next rollingAmount days, even if
  // that's zero on a slow month. "slots": keep searching forward (capped at
  // SEARCH_CAP_DAYS) until rollingAmount actual slots have been found, so a
  // booked-solid person still always has *something* bookable to show.
  rollingMode: "days",
  rollingAmount: 21,
};
const SLOT_GRID_MINUTES = 15;
const SEARCH_CAP_DAYS = 180;

// Same two embed patterns Calendly offers: an inline widget (auto-scans for
// `.scheduling-inline-widget[data-url]` on load and injects an iframe) and
// a popup widget (`SchedulingWidget.initPopupWidget({url})`, called from an
// onclick). Kept dependency-free and small enough to inline-review at a glance.
const WIDGET_JS = `(function(){
  function injectStyles(){
    if (document.getElementById('scheduling-widget-styles')) return;
    var s = document.createElement('style');
    s.id = 'scheduling-widget-styles';
    s.textContent = '.scheduling-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px}.scheduling-overlay iframe{width:100%;max-width:900px;height:90vh;border:0;border-radius:12px;background:#fff}.scheduling-overlay .scheduling-close{position:absolute;top:20px;right:24px;color:#fff;font-size:32px;cursor:pointer;background:none;border:none;line-height:1}';
    document.head.appendChild(s);
  }
  function openPopup(opts){
    injectStyles();
    var overlay = document.createElement('div');
    overlay.className = 'scheduling-overlay';
    var close = document.createElement('button');
    close.className = 'scheduling-close';
    close.innerHTML = '\\u00d7';
    close.onclick = function(){ document.body.removeChild(overlay); };
    var iframe = document.createElement('iframe');
    iframe.src = opts.url;
    overlay.appendChild(iframe);
    overlay.appendChild(close);
    overlay.addEventListener('click', function(e){ if (e.target === overlay) document.body.removeChild(overlay); });
    document.body.appendChild(overlay);
  }
  function initInlineWidgets(){
    var els = document.querySelectorAll('.scheduling-inline-widget[data-url]');
    for (var i = 0; i < els.length; i++){
      var el = els[i];
      if (el.getAttribute('data-scheduling-initialized')) continue;
      el.setAttribute('data-scheduling-initialized', '1');
      var iframe = document.createElement('iframe');
      iframe.src = el.getAttribute('data-url');
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = '0';
      iframe.style.minHeight = el.style.height || '700px';
      el.appendChild(iframe);
    }
  }
  window.SchedulingWidget = { initPopupWidget: openPopup };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initInlineWidgets);
  else initInlineWidgets();
})();`;

// Lazily seeds a "default" calendar (the connected account's own) from the
// legacy global crm_availability.json the first time it's needed, and
// migrates any legacy flat team-calendars entries into full calendar
// records (their own default availability to start) -- both one-time,
// idempotent (re-checked by id/email presence, not a version flag).
function getCalendars() {
  let calendars = readJson(CALENDARS_FILE, []);
  let changed = false;
  if (!calendars.some(c => c.id === "default")) {
    const legacyAvailability = readJson(AVAILABILITY_FILE, null);
    calendars.unshift({
      id: "default", name: "My Calendar", email: "", isDefault: true,
      availability: { ...DEFAULT_CALENDAR_AVAILABILITY, ...(legacyAvailability || {}) },
      createdAt: new Date().toISOString(),
    });
    changed = true;
  }
  for (const t of readJson(TEAM_CALENDARS_FILE, [])) {
    if (!calendars.some(c => c.email === t.email)) {
      calendars.push({ id: t.id, name: t.name, email: t.email, isDefault: false, availability: { ...DEFAULT_CALENDAR_AVAILABILITY }, createdAt: t.createdAt || new Date().toISOString() });
      changed = true;
    }
  }
  if (changed) writeJson(CALENDARS_FILE, calendars);
  return calendars;
}
function getCalendarById(id) {
  const calendars = getCalendars();
  return calendars.find(c => c.id === id) || calendars.find(c => c.id === "default");
}
// Event types created before calendars existed only have the old
// calendarEmail field -- resolved here rather than force-migrated on write,
// so a stale event type keeps working even if nobody's opened its Design
// page since this shipped.
function resolveCalendarForEventType(et) {
  if (et.calendarId) return getCalendarById(et.calendarId);
  if (et.calendarEmail) {
    const match = getCalendars().find(c => c.email === et.calendarEmail);
    if (match) return match;
  }
  return getCalendarById("default");
}

// Reads event types, resolving+persisting a real calendarId (and dropping
// the legacy calendarEmail/bufferMinutes fields) for any record still in
// the pre-calendars shape -- one-time per event type, same lazy-migration
// pattern as getCalendars() above. Every other route reads through this
// instead of the raw file so a stale record never lingers past its first load.
function getEventTypes() {
  const eventTypes = readJson(EVENT_TYPES_FILE, []);
  let changed = false;
  for (const et of eventTypes) {
    if ("calendarEmail" in et || "bufferMinutes" in et) {
      if (!et.calendarId) et.calendarId = resolveCalendarForEventType(et).id;
      delete et.calendarEmail;
      delete et.bufferMinutes;
      changed = true;
    }
  }
  if (changed) writeJson(EVENT_TYPES_FILE, eventTypes);
  return eventTypes;
}

// ── Anchorage-timezone wall-clock <-> UTC, same DST-aware Intl trick used by
// ../update_ads_tracking_daily.js -- reimplemented here since scheduling_backend.js
// is its own deployment with no import path to that script.
function anchorageOffsetHours(atMs) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Anchorage", timeZoneName: "shortOffset" }).formatToParts(new Date(atMs));
  const m = (parts.find(p => p.type === "timeZoneName")?.value || "GMT-8").match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1], 10) : -8;
}
function localTimeToUTC(dateStr, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const offset = anchorageOffsetHours(Date.parse(dateStr + "T20:00:00Z")); // midday-ish Anchorage instant, safely inside dateStr
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - offset, m));
}
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

// ── Google Calendar — same connected account (lee@pacificrimathletics.com,
// via ../get_calendar_token.js) and request shapes as chat-app/chat_backend.js's
// appointment booking, copied rather than imported (separate deployments).
export function calendarConfigured() {
  return !!(process.env.GOOGLE_REFRESH_TOKEN_PRA_CALENDAR && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function getCalendarId() { return process.env.GOOGLE_CALENDAR_ID || "primary"; }
async function getCalendarAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN_PRA_CALENDAR, grant_type: "refresh_token",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Calendar token refresh failed: " + JSON.stringify(d));
  return d.access_token;
}
// The "connected" pill just says yes/no -- it never surfaced WHICH Google
// account that actually is, so a blank "your connected account" email field
// on the default calendar looked like nothing was really wired up. This
// fetches that account's own address (Google Calendar's "primary" calendar
// id IS the owning account's email) so the UI can show it plainly.
async function getConnectedCalendarEmail() {
  if (!calendarConfigured()) return null;
  const accessToken = await getCalendarAccessToken();
  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Fetching connected calendar identity failed: " + JSON.stringify(d));
  return d.id || null; // "id" on the primary calendar is the account's email
}
// The calendars the connected account can actually see in Google Calendar
// (its own + anything shared/subscribed to it), so the editor's Calendar
// picker can offer them directly instead of requiring someone to already
// know a teammate's exact Workspace email to type in. minAccessRole=writer
// since a calendar this app can't create/delete events on isn't usable here.
async function listGoogleCalendars() {
  if (!calendarConfigured()) return [];
  const accessToken = await getCalendarAccessToken();
  const r = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Listing calendars failed: " + JSON.stringify(d));
  return (d.items || []).map(c => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary }));
}
// Busy intervals for [startISO, endISO) on the given calendar -- merged into
// slot computation so a real conflict (including events not created by this
// scheduler, e.g. someone blocking off vacation directly in Google
// Calendar) blocks a slot, not just bookings this app made itself.
// calendarId defaults to the connected account's own calendar, but an event
// type can target any other Workspace member's calendar instead (see
// TEAM_CALENDARS_FILE below) -- the single connected OAuth token can read/
// write any calendar in the same Google Workspace domain without a
// per-person auth flow, same as chat-app's appointment booking relies on.
async function fetchFreeBusy(startISO, endISO, calendarId) {
  calendarId = calendarId || getCalendarId();
  const accessToken = await getCalendarAccessToken();
  const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: startISO, timeMax: endISO, items: [{ id: calendarId }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("freeBusy failed: " + JSON.stringify(d));
  return (d.calendars?.[calendarId]?.busy || []).map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }));
}
async function createCalendarEvent({ summary, description, startISO, durationMinutes, attendees, timezone, calendarId }) {
  calendarId = calendarId || getCalendarId();
  const accessToken = await getCalendarAccessToken();
  const start = new Date(startISO);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const body = {
    summary, description,
    start: { dateTime: start.toISOString(), timeZone: timezone },
    end: { dateTime: end.toISOString(), timeZone: timezone },
    attendees: (attendees || []).map(a => ({ email: a.email, displayName: a.name })),
    reminders: { useDefault: true },
  };
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Calendar event creation failed: " + JSON.stringify(d));
  return { id: d.id, htmlLink: d.htmlLink };
}
async function deleteCalendarEvent(eventId, calendarId) {
  calendarId = calendarId || getCalendarId();
  const accessToken = await getCalendarAccessToken();
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=all`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok && r.status !== 404 && r.status !== 410) {
    const d = await r.json().catch(() => ({}));
    throw new Error("Calendar event deletion failed: " + JSON.stringify(d));
  }
}

// ── Add-to-calendar links + universal .ics, same shapes as chat-app's ──────
function icsDate(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function icsEscape(s) { return String(s || "").replace(/[\\,;]/g, m => "\\" + m).replace(/\n/g, "\\n"); }
function buildGoogleCalendarLink({ summary, description, start, end, timezone }) {
  const params = new URLSearchParams({ action: "TEMPLATE", text: summary, details: description || "", dates: `${icsDate(start)}/${icsDate(end)}`, ctz: timezone });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
function buildOutlookCalendarLink({ summary, description, start, end }) {
  const params = new URLSearchParams({ path: "/calendar/action/compose", rru: "addevent", subject: summary, body: description || "", startdt: start.toISOString(), enddt: end.toISOString() });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}
function buildIcs({ summary, description, start, end, uid }) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pacific Rim Athletics//CRM Scheduling//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${uid}@pacificrimathletics.com`, `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEscape(summary)}`, `DESCRIPTION:${icsEscape(description)}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}

// ── Event types ──────────────────────────────────────────────────────────
// fontPrimary/fontSecondary are keys into book.html/scheduling-editor.html's
// shared FONT_OPTIONS map (same set form-builder.html uses, for one
// consistent font list across the whole CRM). pageBackgroundColor is the
// color around the card; backgroundColor is the card itself.
const DEFAULT_BRANDING = {
  brandName: "Pacific Rim Athletics", logoUrl: "",
  pageBackgroundColor: "#f2f2f5", backgroundColor: "#ffffff", textColor: "#0a0a0a", accentColor: "#009bff",
  fontPrimary: "default", fontSecondary: "aldrich",
  redirectUrl: "",
};

function newEventType({ name, description, durationMinutes, location, branding, statusId, calendarId }) {
  const slugBase = String(name || "meeting").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "meeting";
  // Defaults to the "BOOKED" status if one exists, same behavior as before
  // this became configurable -- an event type with no explicit statusId
  // still moves a contact into something sensible on booking. Stores the
  // status LABEL, not its id -- contact.status is a label string everywhere
  // else in this app (see contact-detail.html's status <select>, whose
  // option values are s.label; automation/workflow goal-matching compares
  // straight against that string), so an id here would silently never match.
  const defaultStatusId = readJson(STATUSES_FILE, []).find(s => s.label === "BOOKED")?.label || "";
  return {
    id: randomUUID(), slug: slugBase, name: name || "Meeting", description: description || "",
    durationMinutes: Number(durationMinutes) || 30,
    location: location || { type: "zoom", detail: "" },
    branding: { ...DEFAULT_BRANDING, ...(branding || {}) },
    statusId: statusId !== undefined ? statusId : defaultStatusId,
    // References a crm_calendars.json entry -- that calendar's own
    // availability (hours, buffers, rolling window) governs this event
    // type's slots. Defaults to the connected account's own calendar.
    calendarId: calendarId || "default",
    active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}
function publicEventType(et) {
  return { id: et.id, slug: et.slug, name: et.name, description: et.description, durationMinutes: et.durationMinutes, location: et.location, branding: { ...DEFAULT_BRANDING, ...(et.branding || {}) } };
}
function uniqueSlug(base, existing, excludeId) {
  let slug = base, n = 2;
  while (existing.some(e => e.slug === slug && e.id !== excludeId)) slug = `${base}-${n++}`;
  return slug;
}

// ── Slot computation ─────────────────────────────────────────────────────
// opts.previewStart/previewEnd (admin editor preview only): a fixed window,
// ignoring the calendar's rolling mode, so the Design page can browse any
// month freely. The real public booking page never passes these -- it
// always gets however-far-forward the calendar's own rolling setting says.
async function computeAvailableSlots(eventType, opts = {}) {
  const calendar = resolveCalendarForEventType(eventType);
  const avail = { ...DEFAULT_CALENDAR_AVAILABILITY, ...calendar.availability };
  const calendarId = calendar.email || getCalendarId();
  const bookings = readJson(BOOKINGS_FILE, []).filter(b => b.status === "confirmed" && (b.calendarId || getCalendarId()) === calendarId);
  const now = Date.now();
  const minNoticeMs = (avail.minNoticeMinutes ?? 120) * 60000;
  const bufferBeforeMs = (avail.bufferBeforeMinutes ?? 0) * 60000;
  const bufferAfterMs = (avail.bufferAfterMinutes ?? 0) * 60000;

  const today = ymd(new Date());
  const previewMode = !!(opts.previewStart && opts.previewEnd);
  const searchEnd = previewMode ? opts.previewEnd : addDays(today, SEARCH_CAP_DAYS);

  const rangeStartISO = localTimeToUTC(previewMode ? opts.previewStart : today, "00:00").toISOString();
  const rangeEndISO = localTimeToUTC(addDays(searchEnd, 1), "00:00").toISOString();
  let calendarBusy = [];
  if (calendarConfigured()) {
    try { calendarBusy = await fetchFreeBusy(rangeStartISO, rangeEndISO, calendarId); }
    catch { /* degrade to internal-bookings-only conflict checking below */ }
  }
  const internalBusy = bookings.map(b => ({ start: new Date(b.startAt).getTime(), end: new Date(b.endAt).getTime() }));
  // Buffer is a calendar-level setting applied once here, not snapshotted
  // per booking -- padding every busy interval (real calendar events and
  // internal bookings alike) the same way regardless of which event type
  // originally created it.
  const busy = [...calendarBusy, ...internalBusy].map(b => ({ start: b.start - bufferBeforeMs, end: b.end + bufferAfterMs }));

  const byDate = {};
  let totalSlots = 0;
  let cursor = previewMode ? opts.previewStart : today;
  while (cursor <= searchEnd) {
    const override = avail.dateOverrides?.[cursor];
    const dow = String(new Date(cursor + "T12:00:00Z").getUTCDay());
    const rule = override?.closed ? null : (override?.hours || avail.weekly[dow]);
    const daySlots = [];
    if (rule) {
      const dayStart = localTimeToUTC(cursor, rule.start).getTime();
      const dayEnd = localTimeToUTC(cursor, rule.end).getTime();
      const durationMs = eventType.durationMinutes * 60000;
      for (let t = dayStart; t + durationMs <= dayEnd; t += SLOT_GRID_MINUTES * 60000) {
        if (t < now + minNoticeMs) continue;
        const slotEnd = t + durationMs;
        const conflict = busy.some(b => t < b.end && slotEnd > b.start);
        if (!conflict) daySlots.push(new Date(t).toISOString());
      }
    }
    if (daySlots.length) { byDate[cursor] = daySlots; totalSlots += daySlots.length; }
    cursor = addDays(cursor, 1);

    if (!previewMode) {
      if (avail.rollingMode === "slots") { if (totalSlots >= (avail.rollingAmount || 20)) break; }
      else if (cursor > addDays(today, avail.rollingAmount || 21)) break;
    }
  }
  return { byDate, timezone: avail.timezone, calendar };
}

function upsertContactFromBooking({ name, email, phone, statusId }) {
  const contacts = readJson(CONTACTS_FILE, []);
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPhone = String(phone || "").trim();
  let contact = findContactMatch(contacts, normalizedEmail, normalizedPhone);
  const [first, ...rest] = String(name || "").trim().split(/\s+/);
  const last = rest.join(" ");

  if (contact) {
    if (first) contact.first = first;
    if (last) contact.last = last;
    if (normalizedEmail) contact.email = normalizedEmail;
    if (normalizedPhone) contact.phone = normalizedPhone;
    if (statusId) contact.status = statusId;
    contact.updatedAt = new Date().toISOString();
  } else {
    contact = {
      id: randomUUID(), type: "lead", accountName: "",
      first: first || "", last: last || "", email: normalizedEmail, phone: normalizedPhone,
      status: statusId || "", tags: [], listIds: [], customFields: {},
      source: "scheduling", ownerId: null, emailOptOut: false, smsOptOut: false,
      externalIds: { acContactId: null, closeLeadId: null },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    contacts.push(contact);
  }
  writeJson(CONTACTS_FILE, contacts);
  return contact;
}

function locationText(location) {
  if (!location) return "";
  if (location.type === "zoom") return location.detail || "Zoom link will be sent by email";
  if (location.type === "phone") return "Phone call — we'll call you";
  if (location.type === "in_person") return location.detail || "In person";
  return location.detail || "";
}

async function sendBookingConfirmation(booking, eventType, contact) {
  const start = new Date(booking.startAt);
  const when = start.toLocaleString("en-US", { timeZone: booking.timezone || "America/Anchorage", dateStyle: "full", timeStyle: "short" });
  const cancelUrl = `${getPublicBaseUrl()}/book/${eventType.slug}/manage?booking=${booking.id}&token=${booking.cancelToken}`;
  const html = `<p>Hi ${contact.first || "there"},</p>
    <p>You're booked for <b>${eventType.name}</b>.</p>
    <p><b>When:</b> ${when}<br/><b>Where:</b> ${locationText(eventType.location)}</p>
    ${booking.notes ? `<p><b>Notes:</b> ${booking.notes}</p>` : ""}
    <p>Need to cancel? <a href="${cancelUrl}">${cancelUrl}</a></p>`;
  await sendEmail({
    to: contact.email, subject: `Confirmed: ${eventType.name}`,
    blocks: [{ id: "b1", type: "text", html }], theme: {}, footerTemplateId: null,
    contactId: contact.id, sourceType: "booking", sourceId: booking.id,
  }).catch(() => {});
  if (contact.phone) {
    await sendSms({
      to: contact.phone, body: `You're booked for ${eventType.name} on ${when}. Cancel: ${cancelUrl}`,
      contactId: contact.id, sourceType: "booking", sourceId: booking.id,
    }).catch(() => {});
  }
}

export async function handleSchedulingRequest(req, res, url) {
  const p = url.pathname;

  // ── Clean public URL (/book/:slug) -- same static-SPA-shell pattern as
  // forms_backend.js's /f/:id, the slug is read client-side from location.pathname.
  const bookPageMatch = p.match(/^\/book\/[^/]+(?:\/manage)?$/);
  if (bookPageMatch && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readFileSync(join(__dirname, "book.html")));
    return true;
  }

  // ── Embed widget -- same "one small self-contained script" pattern as
  // tracking_backend.js's /track.js, but this one's meant to be referenced
  // by <script src>, not inlined: it needs to run fresh on every page load
  // (bugfixes land automatically) and its whole job is DOM injection, which
  // only works loaded live in the embedding page, not copy-pasted as text.
  if (p === "/widget.js" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(WIDGET_JS);
    return true;
  }

  // ── Public: event type lookup, availability, booking create/cancel ──────
  const publicEtMatch = p.match(/^\/api\/scheduling\/event-types\/([^/]+)$/);
  if (publicEtMatch && req.method === "GET") {
    const eventTypes = getEventTypes();
    const et = eventTypes.find(e => e.slug === publicEtMatch[1] && e.active);
    if (!et) return sendJson(res, 404, { error: "Event type not found" });
    return sendJson(res, 200, { eventType: publicEventType(et) });
  }

  if (p === "/api/scheduling/availability" && req.method === "GET") {
    const slug = url.searchParams.get("slug");
    const eventTypes = getEventTypes();
    const et = eventTypes.find(e => e.slug === slug && e.active);
    if (!et) return sendJson(res, 404, { error: "Event type not found" });
    // start/end are an optional fixed-window override (only the admin
    // Design-page preview passes these, to browse any month) -- the real
    // public booking page always omits them and gets the calendar's own
    // rolling-days/rolling-slots window instead.
    const previewStart = url.searchParams.get("start");
    const previewEnd = url.searchParams.get("end");
    try {
      const { byDate, timezone } = await computeAvailableSlots(et, previewStart && previewEnd ? { previewStart, previewEnd } : {});
      return sendJson(res, 200, { timezone, slots: byDate });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (p === "/api/scheduling/bookings" && req.method === "POST") {
    const { slug, startAt, name, email, phone, notes, timezone } = await readJsonBody(req);
    const eventTypes = getEventTypes();
    const et = eventTypes.find(e => e.slug === slug && e.active);
    if (!et) return sendJson(res, 404, { error: "Event type not found" });
    if (!startAt || !name || !email) return sendJson(res, 400, { error: "startAt, name, and email are required" });

    // Race-safe recheck: confirm this exact slot is still open before booking it.
    const dateStr = ymd(new Date(startAt));
    let freshSlots, calendar;
    try { ({ byDate: freshSlots, calendar } = await computeAvailableSlots(et)); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
    if (!(freshSlots[dateStr] || []).includes(new Date(startAt).toISOString())) {
      return sendJson(res, 409, { error: "That time was just booked — please pick another slot." });
    }

    const contact = upsertContactFromBooking({ name, email, phone, statusId: et.statusId });
    const start = new Date(startAt);
    const end = new Date(start.getTime() + et.durationMinutes * 60000);
    const calendarId = calendar.email || getCalendarId();

    let calendarEventId = null;
    if (calendarConfigured()) {
      try {
        const created = await createCalendarEvent({
          summary: `${et.name} — ${name}`,
          description: `${notes || ""}\n\nBooked via CRM scheduling.`.trim(),
          startISO: start.toISOString(), durationMinutes: et.durationMinutes,
          attendees: [{ email, name }], timezone: timezone || calendar.availability.timezone,
          calendarId,
        });
        calendarEventId = created.id;
      } catch { /* degrade -- booking still saved internally below */ }
    }

    const booking = {
      id: randomUUID(), eventTypeId: et.id, contactId: contact.id,
      name, email: String(email).trim().toLowerCase(), phone: phone || "", notes: notes || "",
      startAt: start.toISOString(), endAt: end.toISOString(),
      timezone: timezone || calendar.availability.timezone,
      status: "confirmed", calendarEventId, calendarId,
      cancelToken: randomBytes(24).toString("hex"),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelledAt: null,
    };
    const bookings = readJson(BOOKINGS_FILE, []);
    bookings.push(booking);
    writeJson(BOOKINGS_FILE, bookings);

    // Log the booking itself as an inbound Inbox activity, same as a form
    // submission -- "they booked a call" should be visible in the
    // conversation thread, not just as a row in the Scheduling tab.
    const when = start.toLocaleString("en-US", { timeZone: booking.timezone, dateStyle: "full", timeStyle: "short" });
    logMessage({
      channel: "booking", direction: "inbound", contactId: contact.id,
      sourceType: "booking", sourceId: booking.id,
      subject: `Booked: ${et.name}`, body: `${when}${notes ? `\n\n${notes}` : ""}`,
      bodyPreview: `${when}${notes ? ` — ${notes}` : ""}`.slice(0, 200),
      status: "received",
    });

    fireTrigger("booking_created", { contactId: contact.id, eventTypeId: et.id });
    fireWorkflowTrigger("booking_created", { contactId: contact.id, eventTypeId: et.id });
    fireFlowTrigger("booking_created", {
      contactId: contact.id, eventTypeId: et.id,
      payload: { "Event Type": et.name, "When": when, "Name": name, "Email": booking.email, "Phone": booking.phone, "Notes": notes || "" },
    });
    checkConversionGoal("meeting_booked", contact.id);

    await sendBookingConfirmation(booking, et, contact);

    const startDate = new Date(booking.startAt), endDate = new Date(booking.endAt);
    return sendJson(res, 200, {
      ok: true,
      booking: { id: booking.id, startAt: booking.startAt, endAt: booking.endAt, timezone: booking.timezone, cancelToken: booking.cancelToken },
      eventType: publicEventType(et),
      addToCalendar: {
        google: buildGoogleCalendarLink({ summary: et.name, description: notes || "", start: startDate, end: endDate, timezone: booking.timezone }),
        outlook: buildOutlookCalendarLink({ summary: et.name, description: notes || "", start: startDate, end: endDate }),
        icsUrl: `/api/scheduling/bookings/${booking.id}/ics?token=${booking.cancelToken}`,
      },
    });
  }

  const icsMatch = p.match(/^\/api\/scheduling\/bookings\/([^/]+)\/ics$/);
  if (icsMatch && req.method === "GET") {
    const bookings = readJson(BOOKINGS_FILE, []);
    const booking = bookings.find(b => b.id === icsMatch[1]);
    if (!booking || booking.cancelToken !== url.searchParams.get("token")) return sendJson(res, 404, { error: "Not found" });
    const eventTypes = getEventTypes();
    const et = eventTypes.find(e => e.id === booking.eventTypeId);
    const ics = buildIcs({ summary: et?.name || "Meeting", description: booking.notes || "", start: new Date(booking.startAt), end: new Date(booking.endAt), uid: booking.id });
    res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="event.ics"` });
    res.end(ics);
    return true;
  }

  const publicBookingMatch = p.match(/^\/api\/scheduling\/bookings\/([^/]+)$/);
  if (publicBookingMatch && req.method === "GET") {
    const bookings = readJson(BOOKINGS_FILE, []);
    const booking = bookings.find(b => b.id === publicBookingMatch[1]);
    if (!booking || booking.cancelToken !== url.searchParams.get("token")) return sendJson(res, 404, { error: "Not found" });
    const eventTypes = getEventTypes();
    const et = eventTypes.find(e => e.id === booking.eventTypeId);
    return sendJson(res, 200, { booking, eventType: et ? publicEventType(et) : null });
  }
  const publicCancelMatch = p.match(/^\/api\/scheduling\/bookings\/([^/]+)\/cancel$/);
  if (publicCancelMatch && req.method === "POST") {
    const { token } = await readJsonBody(req);
    const bookings = readJson(BOOKINGS_FILE, []);
    const booking = bookings.find(b => b.id === publicCancelMatch[1]);
    if (!booking || booking.cancelToken !== token) return sendJson(res, 404, { error: "Not found" });
    if (booking.status === "confirmed") {
      booking.status = "cancelled"; booking.cancelledAt = new Date().toISOString(); booking.updatedAt = new Date().toISOString();
      writeJson(BOOKINGS_FILE, bookings);
      if (booking.calendarEventId && calendarConfigured()) await deleteCalendarEvent(booking.calendarEventId, booking.calendarId).catch(() => {});
    }
    return sendJson(res, 200, { ok: true });
  }

  // ── Authed: admin management ─────────────────────────────────────────────
  if (!p.startsWith("/api/scheduling/admin")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/scheduling/admin/status" && req.method === "GET") {
    let connectedEmail = null;
    if (calendarConfigured()) {
      try { connectedEmail = await getConnectedCalendarEmail(); } catch { /* show as connected but unknown-identity below */ }
    }
    return sendJson(res, 200, { calendarConnected: calendarConfigured(), connectedEmail });
  }

  // Calendars -- each one is a Workspace email (blank = the connected
  // account's own) PLUS its own full availability (hours, notice, buffers,
  // rolling window). The single connected OAuth token can read/write any
  // calendar in the same Google Workspace domain, so adding one here is
  // enough, no per-person auth flow needed (same as chat-app's per-coach
  // appointment calendars). Admin-only, same as everything else past the
  // getSessionUser check above -- one operator manages every calendar.
  if (p === "/api/scheduling/admin/calendars" && req.method === "GET") {
    return sendJson(res, 200, { calendars: getCalendars() });
  }
  if (p === "/api/scheduling/admin/google-calendars" && req.method === "GET") {
    try { return sendJson(res, 200, { googleCalendars: await listGoogleCalendars() }); }
    catch (e) { return sendJson(res, 200, { googleCalendars: [], error: e.message }); }
  }
  if (p === "/api/scheduling/admin/calendars" && req.method === "POST") {
    const { name, email } = await readJsonBody(req);
    const calendars = getCalendars();
    const entry = {
      id: randomUUID(), name: name || email || "New Calendar", email: String(email || "").trim().toLowerCase(),
      isDefault: false, availability: { ...DEFAULT_CALENDAR_AVAILABILITY }, createdAt: new Date().toISOString(),
    };
    calendars.push(entry);
    writeJson(CALENDARS_FILE, calendars);
    return sendJson(res, 200, { ok: true, calendar: entry });
  }
  const calMatch = p.match(/^\/api\/scheduling\/admin\/calendars\/([^/]+)$/);
  if (calMatch) {
    const calendars = getCalendars();
    const cal = calendars.find(c => c.id === calMatch[1]);
    if (!cal) return sendJson(res, 404, { error: "Calendar not found" });
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      if ("name" in body) cal.name = body.name;
      if ("email" in body) cal.email = String(body.email || "").trim().toLowerCase();
      if ("availability" in body) cal.availability = { ...DEFAULT_CALENDAR_AVAILABILITY, ...cal.availability, ...(body.availability || {}) };
      cal.updatedAt = new Date().toISOString();
      writeJson(CALENDARS_FILE, calendars);
      return sendJson(res, 200, { ok: true, calendar: cal });
    }
    if (req.method === "DELETE") {
      if (cal.isDefault) return sendJson(res, 400, { error: "Can't delete the default calendar" });
      writeJson(CALENDARS_FILE, calendars.filter(c => c.id !== calMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === "/api/scheduling/admin/event-types" && req.method === "GET") {
    return sendJson(res, 200, { eventTypes: getEventTypes() });
  }
  if (p === "/api/scheduling/admin/event-types" && req.method === "POST") {
    const body = await readJsonBody(req);
    const eventTypes = getEventTypes();
    const et = newEventType(body);
    et.slug = uniqueSlug(et.slug, eventTypes, et.id);
    eventTypes.push(et);
    writeJson(EVENT_TYPES_FILE, eventTypes);
    return sendJson(res, 200, { ok: true, eventType: et });
  }
  const etMatch = p.match(/^\/api\/scheduling\/admin\/event-types\/([^/]+)$/);
  if (etMatch) {
    const eventTypes = getEventTypes();
    const et = eventTypes.find(e => e.id === etMatch[1]);
    if (!et) return sendJson(res, 404, { error: "Event type not found" });
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      for (const k of ["name", "description", "durationMinutes", "location", "active", "statusId", "calendarId"]) if (k in body) et[k] = body[k];
      if ("branding" in body) et.branding = { ...DEFAULT_BRANDING, ...(et.branding || {}), ...(body.branding || {}) };
      if ("name" in body && !("slug" in body)) et.slug = uniqueSlug(String(body.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "meeting", eventTypes, et.id);
      if ("slug" in body && body.slug) et.slug = uniqueSlug(String(body.slug).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), eventTypes, et.id);
      et.updatedAt = new Date().toISOString();
      writeJson(EVENT_TYPES_FILE, eventTypes);
      return sendJson(res, 200, { ok: true, eventType: et });
    }
    if (req.method === "DELETE") {
      writeJson(EVENT_TYPES_FILE, eventTypes.filter(e => e.id !== etMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === "/api/scheduling/admin/bookings" && req.method === "GET") {
    const bookings = readJson(BOOKINGS_FILE, []).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    const eventTypes = getEventTypes();
    const withEventType = bookings.map(b => ({ ...b, eventType: eventTypes.find(e => e.id === b.eventTypeId) ? { name: eventTypes.find(e => e.id === b.eventTypeId).name, slug: eventTypes.find(e => e.id === b.eventTypeId).slug } : null }));
    return sendJson(res, 200, { bookings: withEventType });
  }
  const adminCancelMatch = p.match(/^\/api\/scheduling\/admin\/bookings\/([^/]+)\/cancel$/);
  if (adminCancelMatch && req.method === "POST") {
    const bookings = readJson(BOOKINGS_FILE, []);
    const booking = bookings.find(b => b.id === adminCancelMatch[1]);
    if (!booking) return sendJson(res, 404, { error: "Not found" });
    if (booking.status === "confirmed") {
      booking.status = "cancelled"; booking.cancelledAt = new Date().toISOString(); booking.updatedAt = new Date().toISOString();
      writeJson(BOOKINGS_FILE, bookings);
      if (booking.calendarEventId && calendarConfigured()) await deleteCalendarEvent(booking.calendarEventId, booking.calendarId).catch(() => {});
    }
    return sendJson(res, 200, { ok: true });
  }

  return false;
}
