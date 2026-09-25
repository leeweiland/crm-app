import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, USERS_FILE } from "./auth_backend.js";
import { getContactByIdFast } from "./sqlite_inbox.js";
import { logMessage } from "./message_log.js";
import { createCalendarEvent, deleteCalendarEvent, calendarConfigured, reminderDueMs } from "./scheduling_backend.js";
import { sendEmail } from "./email_backend.js";
import { sendSms } from "./sms_backend.js";
import { getMeetingReminderSettings } from "./integrations_backend.js";
import { resolveContactTimezone } from "./contact_timezone.js";

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
function fillTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
}

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
// in this app reuses the one ticker. Standalone config (Extra Meetings
// Notifications tab, scheduling.html) -- these meetings have no event type
// or calendar behind them to borrow settings from, and always send: an
// empty reminders list for a channel is what turns it off, there's no
// separate enabled/disabled flag. reminderDueMs is the one thing reused
// from scheduling_backend.js (a generic {amount,unit} -> ms helper, same
// shape as an event type's own reminders.email/sms). Each (meeting,
// reminder id) pair is recorded in meeting.remindersSent once sent, so
// re-polling never double-sends -- same proven pattern as chat-app's
// checkAppointmentReminders and scheduling_backend.js's own sendDueBookingReminders.
export async function checkMeetingReminders() {
  const cfg = getMeetingReminderSettings();
  if (!cfg.emailReminders.length && !cfg.smsReminders.length) return;
  const meetings = readJson(MEETINGS_FILE, []).filter(m => m.status === "scheduled");
  if (!meetings.length) return;
  const users = readJson(USERS_FILE, []);
  const now = Date.now();
  let changed = false;

  for (const meeting of meetings) {
    const startMs = new Date(meeting.startISO).getTime();
    if (!startMs || startMs <= now) continue; // meeting already happened
    const contact = getContact(meeting.contactId);
    const coach = users.find(u => u.id === meeting.userId);
    if (!contact || !coach) continue;
    meeting.remindersSent = meeting.remindersSent || [];
    const createdMs = new Date(meeting.createdAt).getTime();

    const start = new Date(meeting.startISO);
    // Contact's own timezone (inferred from their phone number) wins when
    // available and enabled -- "today at 3pm" should read as 3pm where THEY
    // are, not wherever this org-wide fallback happens to be set. Falls back
    // to the meeting's own timezone (set from whichever the scheduling coach
    // was in), then the fixed setting, same order a missing contact tz has
    // always degraded through.
    const contactTz = cfg.useContactTimezone ? resolveContactTimezone(contact.phone) : null;
    const tz = contactTz?.tz || meeting.timezone || cfg.timezone;
    const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
    const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
    const vars = { coachName: `${coach.first} ${coach.last}`, firstName: contact.first || "", lastName: contact.last || "", date: dateStr, time: timeStr, duration: meeting.durationMinutes };

    for (const reminder of cfg.emailReminders) {
      if (meeting.remindersSent.includes(reminder.id)) continue;
      if (!contact.email) continue;
      const dueAt = startMs - reminderDueMs(reminder);
      // A reminder whose "before" window had already elapsed by the time
      // the meeting was even scheduled (same-day, with a 24-hours-before
      // reminder configured) never had a real advance-notice window to
      // fill -- skip it permanently instead of firing it retroactively.
      if (dueAt < createdMs) continue;
      if (now < dueAt) continue; // not due yet
      try {
        // Same customBlocks pattern as scheduling_backend.js's sendBookingEmail
        // -- fill the {{tokens}} into each text block's html before it goes
        // through the block renderer, so the visual email creator's content
        // (images/buttons alongside text) survives, not just a plain string.
        const blocks = (cfg.emailBlocks || []).map(b => (b.type === "text" && b.html) ? { ...b, html: fillTemplate(b.html, vars) } : b);
        await sendEmail({
          to: contact.email, subject: fillTemplate(cfg.emailReminderSubjectTemplate, vars),
          previewText: fillTemplate(cfg.emailPreviewTextTemplate, vars) || undefined,
          blocks, theme: cfg.emailTheme || {}, footerTemplateId: cfg.emailFooterTemplateId || null, contactId: contact.id,
          sourceType: "meeting", sourceId: meeting.id, from: coach.email,
        });
        meeting.remindersSent.push(reminder.id);
        changed = true;
      } catch (e) {
        console.error(`[meeting reminder] email #${reminder.id} for meeting ${meeting.id} failed:`, e.message);
      }
    }
    for (const reminder of cfg.smsReminders) {
      if (meeting.remindersSent.includes(reminder.id)) continue;
      if (!contact.phone) continue;
      const dueAt = startMs - reminderDueMs(reminder);
      if (dueAt < createdMs) continue;
      if (now < dueAt) continue;
      try {
        await sendSms({ to: contact.phone, body: fillTemplate(cfg.smsReminderTemplate, vars), contactId: contact.id, sourceType: "meeting", sourceId: meeting.id });
        meeting.remindersSent.push(reminder.id);
        changed = true;
      } catch (e) {
        console.error(`[meeting reminder] sms #${reminder.id} for meeting ${meeting.id} failed:`, e.message);
      }
    }
  }
  if (changed) writeJson(MEETINGS_FILE, meetings);
}
