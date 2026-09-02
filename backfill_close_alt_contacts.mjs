// One-time backfill: import_backend.js's upsertFromCloseLead only ever kept
// emails[0]/phones[0] from each Close lead's nested contact, discarding any
// additional emails/phones Close had on file. Nothing was deleted -- it was
// just never copied in -- so this re-fetches every Close-sourced contact's
// full lead record and folds any extra emails/phones into altEmails/
// altPhones (see segments_shared.js's findContactMatch, now checking both).
//
// Usage: node backfill_close_alt_contacts.mjs [--limit=N] [--start=N]
//   --limit: stop after processing N contacts (for a test run)
//   --start: skip the first N Close-sourced contacts (resume after a
//            partial run -- this script logs its index as it goes)
//
// Rate-limited to stay well under Close's API limits; checkpoints progress
// to backfill_close_alt_progress.json every 50 contacts so a killed/crashed
// run can resume with --start=<lastIndex> instead of starting over.
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const CONTACTS_PATH = join(DATA_DIR, "crm_contacts.json");
const PROGRESS_PATH = join(DATA_DIR, "backfill_close_alt_progress.json");
const CLOSE_BASE = "https://api.close.com/api/v1";

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--(\w+)=(.+)$/);
  return m ? [m[1], Number(m[2])] : [a.replace(/^--/, ""), true];
}));
const LIMIT = args.limit || Infinity;
const START = args.start || 0;

if (!process.env.CLOSE_API_KEY) { console.error("CLOSE_API_KEY not set"); process.exit(1); }
const AUTH = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");

async function fetchCloseLeadById(leadId) {
  const r = await fetch(`${CLOSE_BASE}/lead/${leadId}/`, { headers: { Authorization: AUTH } });
  if (r.status === 429) {
    const retryAfter = Number(r.headers.get("retry-after") || 2);
    await new Promise(res => setTimeout(res, retryAfter * 1000));
    return fetchCloseLeadById(leadId);
  }
  return r.ok ? await r.json() : null;
}

console.log("Reading contacts from", CONTACTS_PATH, "...");
const t0 = Date.now();
const contacts = JSON.parse(readFileSync(CONTACTS_PATH, "utf8"));
console.log(`Read ${contacts.length} contacts in ${Date.now() - t0}ms`);

const targets = contacts.filter(c => c.externalIds?.closeLeadId);
console.log(`${targets.length} contacts have a Close lead ID -- processing from index ${START}, limit ${LIMIT === Infinity ? "none" : LIMIT}`);

let processed = 0, updated = 0, errors = 0;
for (let i = START; i < targets.length && processed < LIMIT; i++) {
  const contact = targets[i];
  processed++;
  try {
    const lead = await fetchCloseLeadById(contact.externalIds.closeLeadId);
    if (!lead) { continue; }
    const nested = lead.contacts?.length ? lead.contacts : [];
    // Match the SAME nested-contact-to-CRM-contact identity the original
    // import used (email match), not just "the first nested contact" --
    // a Close lead with multiple people (spouse/partner) already became
    // separate CRM contacts at import time, so this only ever pulls extra
    // emails/phones belonging to the SAME person, not a household-mate's.
    const nc = nested.find(n => (n.emails || []).some(e => e.email?.toLowerCase() === contact.email?.toLowerCase()))
      || nested.find(n => (n.phones || []).some(p => String(p.phone || "").replace(/\D/g, "").slice(-10) === String(contact.phone || "").replace(/\D/g, "").slice(-10)))
      || nested[0];
    if (!nc) continue;
    const digits = (p) => String(p || "").replace(/\D/g, "").slice(-10);
    const primaryPhoneDigits = digits(contact.phone);
    const extraEmails = (nc.emails || []).map(e => e.email).filter(Boolean).filter(e => e.toLowerCase() !== contact.email?.toLowerCase());
    // Compare by normalized last-10-digits, not raw string equality -- Close
    // itself sometimes lists the SAME number twice in different formats
    // ("+14088326290" vs "4088326290"), which a naive string compare
    // mistook for a second, genuinely different phone number.
    const extraPhones = (nc.phones || []).map(p => p.phone).filter(Boolean).filter(p => digits(p) !== primaryPhoneDigits);
    if (!extraEmails.length && !extraPhones.length) continue;
    contact.altEmails = [...new Set([...(contact.altEmails || []), ...extraEmails.map(e => e.toLowerCase())])];
    contact.altPhones = [...new Set([...(contact.altPhones || []), ...extraPhones])].filter((p, i, arr) =>
      arr.findIndex(p2 => digits(p2) === digits(p)) === i // also dedup WITHIN altPhones itself by normalized digits
    );
    updated++;
  } catch (e) {
    errors++;
    console.error(`[${i}] ${contact.id} failed:`, e.message);
  }
  if (processed % 50 === 0) {
    writeFileSync(CONTACTS_PATH, JSON.stringify(contacts));
    writeFileSync(PROGRESS_PATH, JSON.stringify({ lastIndex: i, processed, updated, errors, at: new Date().toISOString() }));
    console.log(`[${processed}/${Math.min(targets.length - START, LIMIT)}] index=${i} updated=${updated} errors=${errors}`);
  }
  // Close's rate limit is generous but not unlimited -- a small delay keeps
  // this well clear of it without meaningfully slowing the run down.
  await new Promise(res => setTimeout(res, 60));
}

writeFileSync(CONTACTS_PATH, JSON.stringify(contacts));
writeFileSync(PROGRESS_PATH, JSON.stringify({ lastIndex: START + processed - 1, processed, updated, errors, done: processed >= targets.length - START || processed >= LIMIT, at: new Date().toISOString() }));
console.log(`\nDone. Processed ${processed}, updated ${updated} with extra emails/phones, ${errors} errors. Total time ${Math.round((Date.now() - t0) / 1000)}s.`);
