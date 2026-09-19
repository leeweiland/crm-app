// ONE-TIME migration (2026-09-18): contacts who came in over the past week
// typed a non-US phone in their own national format ("07956 650003"), which
// was stored exactly as typed -- see phone_util.js. Runs at boot, in-process,
// before .listen() (a separate script sharing the live container is what
// destabilized production earlier -- see server.js's warmCaches comment), and
// touches ONLY contacts created/updated since PHONE_FIX_SINCE whose number
// phone_util.js can confidently attribute to a country. Everything it can't be
// sure of is left alone and listed in the report instead of guessed.
//
// Every change (contact id, old phone, new phone) is written to
// PHONE_FIX_REPORT so it can be reverted by hand; PHONE_FIX_MARKER makes it a
// no-op on every later boot.
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { readJson, writeJson, updateJsonArrayRecordsByIds, DATA_DIR } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { PAGE_VISITS_FILE } from "./tracking_backend.js";
import { upsertContactIndex, syncContactFields } from "./sqlite_inbox.js";
import { normalizePhoneForCapture, countryFromName } from "./phone_util.js";

const PHONE_FIX_SINCE = "2026-09-11";
const BOOKINGS_FILE = "crm_bookings.json";

// Run once per tag. "2026-09-18" was the first pass (national-format numbers
// only). "2026-09-19-v2" re-runs it for what arrived through the Framer
// webhook between that deploy and the webhook fix, and also canonicalizes
// numbers that already had a "+" (e.g. "+4407956495093", trunk 0 left in).
export function runRecentInternationalPhoneFix(tag = "2026-09-18") {
  const PHONE_FIX_MARKER = join(DATA_DIR, `_phone_fix_${tag}.done`);
  const PHONE_FIX_REPORT = join(DATA_DIR, `_phone_fix_${tag}_report.json`);
  if (existsSync(PHONE_FIX_MARKER)) return;
  const includePlus = tag !== "2026-09-18";
  const t0 = Date.now();
  const contacts = readJson(CONTACTS_FILE, []);
  const candidates = contacts.filter(c => (c.createdAt >= PHONE_FIX_SINCE || c.updatedAt >= PHONE_FIX_SINCE) && String(c.phone || "").trim() && (includePlus || !String(c.phone).trim().startsWith("+")) && !/^1?[2-9]\d{2}[2-9]\d{6}$/.test(String(c.phone).replace(/\D/g, "")));
  if (!candidates.length) { writeFileSync(PHONE_FIX_MARKER, new Date().toISOString()); return; }

  // Evidence beyond the number's own shape: the country the visitor's IP
  // resolved to on any page visit attributed to them, and the timezone they
  // picked on a booking.
  const ids = new Set(candidates.map(c => c.id));
  const visitCountry = new Map();
  for (const v of readJson(PAGE_VISITS_FILE, [])) {
    if (v.contactId && ids.has(v.contactId) && v.location?.country && !visitCountry.has(v.contactId)) visitCountry.set(v.contactId, countryFromName(v.location.country));
  }
  const bookings = readJson(BOOKINGS_FILE, []);
  const bookingTz = new Map();
  for (const b of bookings) if (b.contactId && ids.has(b.contactId) && b.timezone) bookingTz.set(b.contactId, b.timezone);

  const changes = [], skipped = [];
  for (const c of candidates) {
    const next = normalizePhoneForCapture(c.phone, { countryCode: visitCountry.get(c.id) || "", timezone: bookingTz.get(c.id) || "" });
    if (next && next !== String(c.phone).trim() && next.startsWith("+")) changes.push({ id: c.id, name: `${c.first || ""} ${c.last || ""}`.trim(), from: c.phone, to: next });
    else if (!String(c.phone).trim().startsWith("+")) skipped.push({ id: c.id, name: `${c.first || ""} ${c.last || ""}`.trim(), phone: c.phone, reason: "no confident country for this number" });
  }

  const byId = new Map(changes.map(ch => [ch.id, ch.to]));
  if (byId.size) {
    const now = new Date().toISOString();
    const updated = updateJsonArrayRecordsByIds(CONTACTS_FILE, [...byId.keys()], c => { c.phone = byId.get(c.id); c.updatedAt = now; return c; });
    for (const c of updated) {
      try { upsertContactIndex(c); } catch (e) { console.error("[phone-fix] contacts_idx update failed:", e.message); }
      try { syncContactFields(c.id, c); } catch (e) { console.error("[phone-fix] inbox sync failed:", e.message); }
    }
    // The booking record keeps its own copy of the phone (used by the
    // confirmation/reminder emails and shown in the admin Bookings tab).
    let touchedBookings = 0;
    for (const b of bookings) {
      const oldToNew = changes.find(ch => ch.id === b.contactId && ch.from === b.phone);
      if (oldToNew) { b.phone = oldToNew.to; touchedBookings++; }
    }
    if (touchedBookings) writeJson(BOOKINGS_FILE, bookings);
  }
  writeFileSync(PHONE_FIX_REPORT, JSON.stringify({ ranAt: new Date().toISOString(), since: PHONE_FIX_SINCE, changed: changes, leftAlone: skipped }, null, 2));
  writeFileSync(PHONE_FIX_MARKER, new Date().toISOString());
  console.log(`[phone-fix] ${changes.length} contact phone(s) normalized, ${skipped.length} left alone, in ${Date.now() - t0}ms (report: ${PHONE_FIX_REPORT})`);
}
