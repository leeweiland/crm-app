import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { getContactByIdFast } from "./sqlite_inbox.js";
import { logMessage } from "./message_log.js";
import { createCalendarEvent, deleteCalendarEvent, calendarConfigured, getEventTypes, sendBookingEmail, sendBookingSms, reminderDueMs } from "./scheduling_backend.js";
import { getMeetingReminderSettings } from "./integrations_backend.js";

// Meetings scheduled directly from the Inbox (calendar icon on a contact's
// chat panel) -- distinct from scheduling_backend.js's self-serve Calendly-
// style booking pages: a coach picks the time themselves here, for one
// specific contact they're already talking to. Always goes on the LOGGED-IN
// coach's own calendar (calendarEmail if set, else their login email), same
// "always your own" rule the Zoom link display follows -- whoever schedules
// the meeting is who's actually running it. The contact is added as a
// Google Calendar attendee so they get the invite/updates straight from
// Google, same as chat-app's proven approach -- no separate contact-side
// event or invite email to maintain here.
export const MEETINGS_FILE = "crm_meetings.json";

function getContact(id) { return getContactByIdFast(id); }

export async function handleMeetingsRequest(req, res, url) {
  const p = url.pathname;
  if (p !== "/api/meetings" && !p.startsWith("/api/meetings/")) return false;

  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/meetings" && req.method === "GET") {
    const contactId = url.searchParams.get("contactId");
    let meetings = readJson(MEETINGS_FILE, []);
    if (contactId) meetings = meetings.filter(m => m.contactId === contactId);
    meetings.sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
    return sendJson(res, 200, { meetings });
  }

  if (p === "/api/meetings" && req.method === "POST") {
    if (!calendarConfigured()) return sendJson(res, 400, { error: "Google Calendar isn't connected yet -- ask an admin to set it up." });
    const { contactId, startISO, durationMinutes, title } = await readJsonBody(req);
    if (!contactId || !startISO) return sendJson(res, 400, { error: "contactId and startISO are required" });
    const contact = getContact(contactId);
    if (!contact) return sendJson(res, 404, { error: "Contact not found" });
    const start = new Date(startISO);
    if (isNaN(start.getTime()) || start.getTime() <= Date.now()) return sendJson(res, 400, { error: "startISO must be a valid time in the future" });
    const duration = Number(durationMinutes) > 0 ? Number(durationMinutes) : 30;
    const calendarId = me.calendarEmail || me.email;
    const timezone = getMeetingReminderSettings().timezone;
    const contactName = `${contact.first || ""} ${contact.last || ""}`.trim() || contact.email || contact.phone || "Contact";
    const summary = title || `${contactName} & ${me.first} ${me.last}`;

    let event;
    try {
      event = await createCalendarEvent({
        summary, description: "", startISO: start.toISOString(), durationMinutes: duration,
        attendees: contact.email ? [{ email: contact.email, name: contactName }] : [],
        timezone, calendarId,
      });
    } catch (e) {
      return sendJson(res, 500, { error: "Calendar event creation failed: " + e.message });
    }

    const meeting = {
      id: randomUUID(), contactId, userId: me.id, title: summary,
      startISO: start.toISOString(), durationMinutes: duration, timezone,
      calendarId, calendarEventId: event.id, calendarEventLink: event.htmlLink,
      status: "scheduled", remindersSent: [], createdAt: new Date().toISOString(),
    };
    const meetings = readJson(MEETINGS_FILE, []);
    meetings.push(meeting);
    writeJson(MEETINGS_FILE, meetings);

    const when = start.toLocaleString("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "short" });
    logMessage({
      channel: "meeting", direction: "outbound", contactId,
      sourceType: "meeting", sourceId: meeting.id,
      subject: `Meeting scheduled: ${summary}`, body: `${when} · ${duration} min`,
      status: "sent",
    });

    return sendJson(res, 200, { ok: true, meeting });
  }

  const cancelMatch = p.match(/^\/api\/meetings\/([^/]+)$/);
  if (cancelMatch && req.method === "DELETE") {
    const meetings = readJson(MEETINGS_FILE, []);
    const meeting = meetings.find(m => m.id === cancelMatch[1]);
    if (!meeting) return sendJson(res, 404, { error: "Meeting not found" });
    if (meeting.status === "scheduled" && meeting.calendarEventId) {
      try { await deleteCalendarEvent(meeting.calendarEventId, meeting.calendarId); }
      catch (e) { console.error("[meetings] calendar delete failed", meeting.id, e.message); }
    }
    meeting.status = "cancelled";
    writeJson(MEETINGS_FILE, meetings);
    logMessage({
      channel: "meeting", direction: "outbound", contactId: meeting.contactId,
      sourceType: "meeting", sourceId: meeting.id,
      subject: `Meeting cancelled: ${meeting.title}`, body: "", status: "sent",
    });
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

// ── Email/SMS reminders ─────────────────────────────────────────────────
// Polled from the shared scheduler (scheduler.js) rather than its own
// setInterval -- see scheduler.js's own comment on why every timed feature
// in this app reuses the one ticker. Reuses one real event type's own
// confirmation.email/sms content and reminders.email/sms timing wholesale
// (via scheduling_backend.js's sendBookingEmail/sendBookingSms, the exact
// same functions a real booking's reminders go through) instead of a
// separate, duplicated set of timing/copy fields -- an admin edits wording
// and cadence in exactly one place (that event type's Design page) and it
// covers both real bookings AND ad-hoc Inbox-scheduled meetings. Which
// event type to borrow from is set on the Extra Meeting Notifications tab
// (scheduling.html); no event type linked means no meeting reminders send
// at all, same as an event type with an empty reminders list today.
// Each (meeting, reminder id) pair is recorded in meeting.remindersSent
// once sent, so re-polling never double-sends -- same proven pattern as
// chat-app's checkAppointmentReminders and scheduling_backend.js's own
// sendDueBookingReminders.
export async function checkMeetingReminders() {
  const { linkedEventTypeId } = getMeetingReminderSettings();
  if (!linkedEventTypeId) return;
  const et = getEventTypes().find(e => e.id === linkedEventTypeId);
  if (!et) return;
  const emailReminders = et.reminders?.email || [];
  const smsReminders = et.reminders?.sms || [];
  if (!emailReminders.length && !smsReminders.length) return;

  const meetings = readJson(MEETINGS_FILE, []).filter(m => m.status === "scheduled");
  if (!meetings.length) return;
  const now = Date.now();
  let changed = false;

  for (const meeting of meetings) {
    const startMs = new Date(meeting.startISO).getTime();
    if (!startMs || startMs <= now) continue; // meeting already happened
    const contact = getContact(meeting.contactId);
    if (!contact) continue;
    meeting.remindersSent = meeting.remindersSent || [];
    const createdMs = new Date(meeting.createdAt).getTime();
    // sendBookingEmail/sendBookingSms only need these fields off "booking" --
    // a meeting has no notes field of its own, so that token just resolves empty.
    const fakeBooking = { id: meeting.id, startAt: meeting.startISO, timezone: meeting.timezone, notes: "" };

    for (const reminder of emailReminders) {
      if (meeting.remindersSent.includes(reminder.id)) continue;
      if (!contact.email) continue;
      const dueAt = startMs - reminderDueMs(reminder);
      // Same "don't fire retroactively" rule as sendDueBookingReminders --
      // a meeting booked same-day with a 24-hours-before reminder configured
      // never had a real advance-notice window to fill.
      if (dueAt < createdMs) continue;
      if (now < dueAt) continue;
      await sendBookingEmail(fakeBooking, et, contact, true).catch(() => {});
      meeting.remindersSent.push(reminder.id);
      changed = true;
    }
    for (const reminder of smsReminders) {
      if (meeting.remindersSent.includes(reminder.id)) continue;
      if (!contact.phone) continue;
      const dueAt = startMs - reminderDueMs(reminder);
      if (dueAt < createdMs) continue;
      if (now < dueAt) continue;
      await sendBookingSms(fakeBooking, et, contact, true).catch(() => {});
      meeting.remindersSent.push(reminder.id);
      changed = true;
    }
  }
  if (changed) writeJson(MEETINGS_FILE, meetings);
}
