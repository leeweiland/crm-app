// Settings > Team Users "Send login": an admin gives a team member a fresh
// random password, and the CRM texts (their Personal Phone) + emails it to
// them with the login link. The CRM never stores real passwords (scrypt hash
// only), so a NEW one is the only thing it can send.
//
// Deliberately bypasses sendSms()/sendEmail(): both write every message into
// the message log, which shows in the Inbox -- a password must never land
// there for every staff member to read. This goes straight to Twilio / SES
// and logs nothing but "sent to <channel>".
import { randomInt } from "crypto";
import twilio from "twilio";
import { getTwilioSettings, getSesSettings, getPublicBaseUrl } from "./integrations_backend.js";

// No look-alike characters (0/O, 1/l/I) -- it's read off a phone screen.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePassword() {
  const pick = n => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${pick(4)}-${pick(4)}-${pick(4)}`;
}

function toE164(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return null;
  if (String(phone).trim().startsWith("+")) return "+" + d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "+" + d;
}

export async function sendLoginCredentials(user, password) {
  const base = (getPublicBaseUrl() || "https://crm-app-production-eb8f.up.railway.app").replace(/\/+$/, "");
  const loginUrl = base + "/login.html";
  const results = { sms: null, email: null };

  const phone = toE164(user.personalPhone);
  const tw = getTwilioSettings();
  if (!phone) results.sms = { ok: false, reason: "No Personal Phone on this user" };
  else if (!tw.accountSid || !tw.authToken || !tw.fromNumber) results.sms = { ok: false, reason: "Twilio not configured" };
  else {
    try {
      await twilio(tw.accountSid, tw.authToken).messages.create({
        from: tw.fromNumber, to: phone,
        body: `Hi ${user.first || ""}, your Pacific Rim Athletics CRM / PRA Inbox login:\n${loginUrl}\nUsername: ${user.email}\nPassword: ${password}\nYou can change it after you log in.`,
      });
      results.sms = { ok: true, to: phone };
    } catch (e) { results.sms = { ok: false, reason: e.message }; }
  }

  const ses = getSesSettings();
  if (!ses.accessKeyId || !ses.secretAccessKey || !ses.fromAddress) results.email = { ok: false, reason: "Email (SES) not configured" };
  else {
    try {
      const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      const client = new SESv2Client({ region: ses.region || "us-east-2", credentials: { accessKeyId: ses.accessKeyId, secretAccessKey: ses.secretAccessKey } });
      const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">
        <p>Hi ${esc(user.first || "")},</p>
        <p>Here's your login for the Pacific Rim Athletics CRM and the PRA Inbox app:</p>
        <p><a href="${esc(loginUrl)}">${esc(loginUrl)}</a><br/>Username: <b>${esc(user.email)}</b><br/>Password: <b>${esc(password)}</b></p>
        <p>In the PRA Inbox app, log in with the same username and password, then tap Allow when it asks about notifications.</p>
        <p>You can change your password after you log in.</p></div>`;
      await client.send(new SendEmailCommand({
        FromEmailAddress: ses.fromAddress,
        Destination: { ToAddresses: [user.email] },
        Content: { Simple: { Subject: { Data: "Your Pacific Rim Athletics CRM login" }, Body: { Html: { Data: html } } } },
        ...(ses.configurationSet ? { ConfigurationSetName: ses.configurationSet } : {}),
      }));
      results.email = { ok: true, to: user.email };
    } catch (e) { results.email = { ok: false, reason: e.message }; }
  }
  console.log(`[send-login] user ${user.id}: sms ${results.sms?.ok ? "sent" : "skipped/failed"}, email ${results.email?.ok ? "sent" : "skipped/failed"}`);
  return results;
}
