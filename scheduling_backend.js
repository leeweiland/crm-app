import { randomUUID, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { STATUSES_FILE } from "./statuses_backend.js";
import { fireTrigger } from "./automations_backend.js";
import { fireWorkflowTrigger, checkConversionGoal } from "./workflows_backend.js";
import { sendEmail } from "./email_backend.js";
import { sendSms } from "./sms_backend.js";
import { getPublicBaseUrl } from "./integrations_backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const EVENT_TYPES_FILE = "crm_event_types.json";
export const BOOKINGS_FILE = "crm_bookings.json";
export const AVAILABILITY_FILE = "crm_availability.json";

const DEFAULT_AVAILABILITY = {
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
};
const SLOT_GRID_MINUTES = 15;
const DAYS_AHEAD_DEFAULT = 21;

function getAvailability() { return { ...DEFAULT_AVAILABILITY, ...readJson(AVAILABILITY_FILE, {}) }; }

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
// Busy intervals on the connected calendar for [startISO, endISO) -- merged
// into slot computation so a real conflict (including events not created by
// this scheduler, e.g. Lee blocking off vacation directly in Google
// Calendar) blocks a slot, not just bookings this app made itself.
async function fetchFreeBusy(startISO, endISO) {
  const accessToken = await getCalendarAccessToken();
  const calendarId = getCalendarId();
  const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: startISO, timeMax: endISO, items: [{ id: calendarId }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("freeBusy failed: " + JSON.stringify(d));
  return (d.calendars?.[calendarId]?.busy || []).map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }));
}
async function createCalendarEvent({ summary, description, startISO, durationMinutes, attendees, timezone }) {
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
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(getCalendarId())}/events?sendUpdates=all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Calendar event creation failed: " + JSON.stringify(d));
  return { id: d.id, htmlLink: d.htmlLink };
}
async function deleteCalendarEvent(eventId) {
  const accessToken = await getCalendarAccessToken();
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(getCalendarId())}/events/${eventId}?sendUpdates=all`, {
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
const DEFAULT_BRANDING = { brandName: "Pacific Rim Athletics", logoUrl: "", backgroundColor: "#ffffff", textColor: "#0a0a0a", accentColor: "#009bff", redirectUrl: "" };

function newEventType({ name, description, durationMinutes, bufferMinutes, location, branding, statusId }) {
  const slugBase = String(name || "meeting").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "meeting";
  // Defaults to the "BOOKED" status if one exists, same behavior as before
  // this became configurable -- an event type with no explicit statusId
  // still moves a contact into something sensible on booking.
  const defaultStatusId = readJson(STATUSES_FILE, []).find(s => s.label === "BOOKED")?.id || "";
  return {
    id: randomUUID(), slug: slugBase, name: name || "Meeting", description: description || "",
    durationMinutes: Number(durationMinutes) || 30, bufferMinutes: Number(bufferMinutes) || 0,
    location: location || { type: "zoom", detail: "" },
    branding: { ...DEFAULT_BRANDING, ...(branding || {}) },
    statusId: statusId !== undefined ? statusId : defaultStatusId,
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
async function computeAvailableSlots(eventType, startDateStr, endDateStr) {
  const availability = getAvailability();
  const bookings = readJson(BOOKINGS_FILE, []).filter(b => b.status === "confirmed");
  const now = Date.now();
  const minNoticeMs = (availability.minNoticeMinutes ?? 120) * 60000;

  const rangeStartISO = localTimeToUTC(startDateStr, "00:00").toISOString();
  const rangeEndISO = localTimeToUTC(addDays(endDateStr, 1), "00:00").toISOString();
  let calendarBusy = [];
  if (calendarConfigured()) {
    try { calendarBusy = await fetchFreeBusy(rangeStartISO, rangeEndISO); }
    catch { /* degrade to internal-bookings-only conflict checking below */ }
  }
  const internalBusy = bookings.map(b => ({
    start: new Date(b.startAt).getTime() - (b.bufferMinutes || 0) * 60000,
    end: new Date(b.endAt).getTime() + (b.bufferMinutes || 0) * 60000,
  }));
  const busy = [...calendarBusy, ...internalBusy];

  const byDate = {};
  let cursor = startDateStr;
  while (cursor <= endDateStr) {
    const override = availability.dateOverrides?.[cursor];
    const dow = String(new Date(cursor + "T12:00:00Z").getUTCDay());
    const rule = override?.closed ? null : (override?.hours || availability.weekly[dow]);
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
    if (daySlots.length) byDate[cursor] = daySlots;
    cursor = addDays(cursor, 1);
  }
  return byDate;
}

// ── Contact upsert, same matched-by-email-then-phone pattern as
// forms_backend.js's upsertContactFromSubmission ──────────────────────────
function upsertContactFromBooking({ name, email, phone, statusId }) {
  const contacts = readJson(CONTACTS_FILE, []);
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPhone = String(phone || "").trim();
  let contact = (normalizedEmail && contacts.find(c => c.email?.toLowerCase() === normalizedEmail))
    || (!normalizedEmail && normalizedPhone && contacts.find(c => c.phone === normalizedPhone));
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

  // ── Public: event type lookup, availability, booking create/cancel ──────
  const publicEtMatch = p.match(/^\/api\/scheduling\/event-types\/([^/]+)$/);
  if (publicEtMatch && req.method === "GET") {
    const eventTypes = readJson(EVENT_TYPES_FILE, []);
    const et = eventTypes.find(e => e.slug === publicEtMatch[1] && e.active);
    if (!et) return sendJson(res, 404, { error: "Event type not found" });
    return sendJson(res, 200, { eventType: publicEventType(et) });
  }

  if (p === "/api/scheduling/availability" && req.method === "GET") {
    const slug = url.searchParams.get("slug");
    const eventTypes = readJson(EVENT_TYPES_FILE, []);
    const et = eventTypes.find(e => e.slug === slug && e.active);
    if (!et) return sendJson(res, 404, { error: "Event type not found" });
    const today = ymd(new Date());
    const start = url.searchParams.get("start") || today;
    const end = url.searchParams.get("end") || addDays(start, DAYS_AHEAD_DEFAULT);
    try {
      const slots = await computeAvailableSlots(et, start, end);
      return sendJson(res, 200, { timezone: getAvailability().timezone, slots });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (p === "/api/scheduling/bookings" && req.method === "POST") {
    const { slug, startAt, name, email, phone, notes, timezone } = await readJsonBody(req);
    const eventTypes = readJson(EVENT_TYPES_FILE, []);
    const et = eventTypes.find(e => e.slug === slug && e.active);
    if (!et) return sendJson(res, 404, { error: "Event type not found" });
    if (!startAt || !name || !email) return sendJson(res, 400, { error: "startAt, name, and email are required" });

    // Race-safe recheck: confirm this exact slot is still open before booking it.
    const dateStr = ymd(new Date(startAt));
    let freshSlots;
    try { freshSlots = await computeAvailableSlots(et, dateStr, dateStr); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
    if (!(freshSlots[dateStr] || []).includes(new Date(startAt).toISOString())) {
      return sendJson(res, 409, { error: "That time was just booked — please pick another slot." });
    }

    const contact = upsertContactFromBooking({ name, email, phone, statusId: et.statusId });
    const start = new Date(startAt);
    const end = new Date(start.getTime() + et.durationMinutes * 60000);
    const availability = getAvailability();

    let calendarEventId = null;
    if (calendarConfigured()) {
      try {
        const created = await createCalendarEvent({
          summary: `${et.name} — ${name}`,
          description: `${notes || ""}\n\nBooked via CRM scheduling.`.trim(),
          startISO: start.toISOString(), durationMinutes: et.durationMinutes,
          attendees: [{ email, name }], timezone: timezone || availability.timezone,
        });
        calendarEventId = created.id;
      } catch { /* degrade -- booking still saved internally below */ }
    }

    const booking = {
      id: randomUUID(), eventTypeId: et.id, contactId: contact.id,
      name, email: String(email).trim().toLowerCase(), phone: phone || "", notes: notes || "",
      startAt: start.toISOString(), endAt: end.toISOString(),
      timezone: timezone || availability.timezone, bufferMinutes: et.bufferMinutes,
      status: "confirmed", calendarEventId,
      cancelToken: randomBytes(24).toString("hex"),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelledAt: null,
    };
    const bookings = readJson(BOOKINGS_FILE, []);
    bookings.push(booking);
    writeJson(BOOKINGS_FILE, bookings);

    fireTrigger("booking_created", { contactId: contact.id, eventTypeId: et.id });
    fireWorkflowTrigger("booking_created", { contactId: contact.id, eventTypeId: et.id });
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
    const eventTypes = readJson(EVENT_TYPES_FILE, []);
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
    const eventTypes = readJson(EVENT_TYPES_FILE, []);
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
      if (booking.calendarEventId && calendarConfigured()) await deleteCalendarEvent(booking.calendarEventId).catch(() => {});
    }
    return sendJson(res, 200, { ok: true });
  }

  // ── Authed: admin management ─────────────────────────────────────────────
  if (!p.startsWith("/api/scheduling/admin")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/scheduling/admin/status" && req.method === "GET") {
    return sendJson(res, 200, { calendarConnected: calendarConfigured() });
  }

  if (p === "/api/scheduling/admin/event-types" && req.method === "GET") {
    return sendJson(res, 200, { eventTypes: readJson(EVENT_TYPES_FILE, []) });
  }
  if (p === "/api/scheduling/admin/event-types" && req.method === "POST") {
    const body = await readJsonBody(req);
    const eventTypes = readJson(EVENT_TYPES_FILE, []);
    const et = newEventType(body);
    et.slug = uniqueSlug(et.slug, eventTypes, et.id);
    eventTypes.push(et);
    writeJson(EVENT_TYPES_FILE, eventTypes);
    return sendJson(res, 200, { ok: true, eventType: et });
  }
  const etMatch = p.match(/^\/api\/scheduling\/admin\/event-types\/([^/]+)$/);
  if (etMatch) {
    const eventTypes = readJson(EVENT_TYPES_FILE, []);
    const et = eventTypes.find(e => e.id === etMatch[1]);
    if (!et) return sendJson(res, 404, { error: "Event type not found" });
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      for (const k of ["name", "description", "durationMinutes", "bufferMinutes", "location", "active", "statusId"]) if (k in body) et[k] = body[k];
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

  if (p === "/api/scheduling/admin/availability" && req.method === "GET") {
    return sendJson(res, 200, { availability: getAvailability() });
  }
  if (p === "/api/scheduling/admin/availability" && req.method === "POST") {
    const body = await readJsonBody(req);
    const current = getAvailability();
    for (const k of ["timezone", "minNoticeMinutes", "weekly", "dateOverrides"]) if (k in body) current[k] = body[k];
    writeJson(AVAILABILITY_FILE, current);
    return sendJson(res, 200, { ok: true, availability: current });
  }

  if (p === "/api/scheduling/admin/bookings" && req.method === "GET") {
    const bookings = readJson(BOOKINGS_FILE, []).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    const eventTypes = readJson(EVENT_TYPES_FILE, []);
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
      if (booking.calendarEventId && calendarConfigured()) await deleteCalendarEvent(booking.calendarEventId).catch(() => {});
    }
    return sendJson(res, 200, { ok: true });
  }

  return false;
}
