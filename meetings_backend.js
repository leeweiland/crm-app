import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, USERS_FILE } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { logMessage } from "./message_log.js";
import { createCalendarEvent, deleteCalendarEvent, calendarConfigured } from "./scheduling_backend.js";
import { sendEmail } from "./email_backend.js";
import { sendSms } from "./sms_backend.js";
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

function getContact(id) { return readJson(CONTACTS_FILE, []).find(c => c.id === id) || null; }
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
// in this app reuses the one ticker. Each (meeting, channel, index) triple
// is recorded in meeting.remindersSent once sent, so re-polling never
// double-sends -- same proven pattern as chat-app's checkAppointmentReminders.
export async function checkMeetingReminders() {
  const meetings = readJson(MEETINGS_FILE, []).filter(m => m.status === "scheduled");
  if (!meetings.length) return;
  const cfg = getMeetingReminderSettings();
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

    const start = new Date(meeting.startISO);
    const tz = meeting.timezone || cfg.timezone;
    const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
    const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
    const vars = { coachName: `${coach.first} ${coach.last}`, firstName: contact.first || "", lastName: contact.last || "", date: dateStr, time: timeStr, duration: meeting.durationMinutes };

    const jobs = [
      ...(cfg.emailRemindersEnabled && contact.email ? cfg.emailReminderMinutesBefore.map((minutesBefore, index) => ({ channel: "email", index, minutesBefore })) : []),
      ...(cfg.smsRemindersEnabled && contact.phone ? cfg.smsReminderMinutesBefore.map((minutesBefore, index) => ({ channel: "sms", index, minutesBefore })) : []),
    ];
    for (const job of jobs) {
      if (now < startMs - job.minutesBefore * 60000) continue; // not due yet
      const key = `${job.channel}:${job.index}`;
      if (meeting.remindersSent.includes(key)) continue;
      try {
        if (job.channel === "email") {
          await sendEmail({
            to: contact.email, subject: fillTemplate(cfg.emailReminderSubjectTemplate, vars),
            blocks: [{ id: "b1", type: "text", html: fillTemplate(cfg.emailReminderBodyTemplate, vars) }],
            theme: {}, footerTemplateId: null, contactId: contact.id,
            sourceType: "meeting", sourceId: meeting.id, from: coach.email,
          });
        } else {
          await sendSms({ to: contact.phone, body: fillTemplate(cfg.smsReminderTemplate, vars), contactId: contact.id, sourceType: "meeting", sourceId: meeting.id });
        }
        meeting.remindersSent.push(key);
        changed = true;
      } catch (e) {
        // Not marked as sent -- retried on the next poll, same as
        // chat-app's reminder loop. If persistently failing it just keeps
        // retrying harmlessly until the meeting time passes and it's
        // skipped by the startMs <= now check above.
        console.error(`[meeting reminder] ${job.channel} #${job.index} for meeting ${meeting.id} failed:`, e.message);
      }
    }
  }
  if (changed) writeJson(MEETINGS_FILE, meetings);
}
