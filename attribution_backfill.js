// ONE-TIME (2026-09-19): link older sign-ups to the ad-click visit that most
// likely brought them, ONLY where the evidence is unambiguous.
//
// Why: Sep 2-15 the site's visits were recorded but the sign-up was never tied
// to the visitor (the submit beacon that does that only exists since Sep 13 and
// the click was lost with the page-visit beacon bug -- see tracking_backend.js).
// The old sign-up data carries no visitor ID, so the ONLY signal left is time:
// who was on the opt-in form page just before the submit.
//
// Rules (a match is skipped unless ALL hold):
//   - an ONLINE EMAIL / GYM EMAIL event (a "1 ONLINE LEAD"/"1 GYM LEAD" flow run)
//     whose contact has no click journey linked yet;
//   - exactly ONE distinct visitor viewed that program's form page (/online-reg*,
//     /gym-reg*) in the 10 minutes before the submit (or up to 1 minute after);
//   - that visitor's visits aren't already linked to a different contact;
//   - no visitor is matched to two contacts, and no contact to two visitors.
// Every visit it links is tagged `inferred: "timing"`, so the report and journeys
// can say so and this can be undone. A backup of the visits file and a per-match
// report are written next to the data.
import { existsSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { readJson, writeJson, DATA_DIR } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { PAGE_VISITS_FILE } from "./tracking_backend.js";
import { FLOWS_FILE, RUNS_FILE } from "./flows_backend.js";

const MARKER = join(DATA_DIR, "_attribution_inferred_2026-09-19.done");
const REPORT = join(DATA_DIR, "_attribution_inferred_2026-09-19_report.json");
const BACKUP = join(DATA_DIR, "_page_visits_before_inference_2026-09-19.json");
const FROM_MS = Date.parse("2026-09-02T00:00:00Z"), TO_MS = Date.parse("2026-09-16T08:00:00Z"); // through the Sep 15 Anchorage day
const WINDOW_BEFORE_MS = 10 * 60000, WINDOW_AFTER_MS = 60000;
const FORM_PATH = { online: /^\/online-reg/, gym: /^\/gym-reg/ };

function visitKey(v) {
  if (v.el) return v.el;
  let p; try { p = new URLSearchParams(v.search || ""); } catch { return null; }
  const h = p.get("h_ad_id");
  if (h) return p.get("fbc_id") ? `meta-ad:${h}` : p.get("gc_id") ? `google-ad:${h}` : `ad:${h}`;
  return null;
}

export function runInferredAttributionBackfill() {
  if (existsSync(MARKER)) return;
  const t0 = Date.now();
  const flows = readJson(FLOWS_FILE, []);
  const findFlowId = (needle) => flows.find(f => (f.name || "").toUpperCase().includes(needle))?.id || null;
  const programByFlow = new Map([[findFlowId("ONLINE LEAD"), "online"], [findFlowId("GYM LEAD"), "gym"]].filter(([id]) => id));
  const visits = readJson(PAGE_VISITS_FILE, []);
  const contacts = readJson(CONTACTS_FILE, []);
  const contactsById = new Map(contacts.filter(c => !c.testContact).map(c => [c.id, c]));

  // visits per visitor, in time order, plus which contact (if any) each visitor is already tied to
  const byVid = new Map(), vidOwner = new Map();
  const trackedContacts = new Set();
  for (const v of visits) {
    if (v.visitorId) {
      (byVid.get(v.visitorId) || byVid.set(v.visitorId, []).get(v.visitorId)).push(v);
      if (v.contactId) vidOwner.set(v.visitorId, v.contactId);
    }
    if (v.contactId && visitKey(v)) trackedContacts.add(v.contactId);
  }
  const formVisits = visits.map(v => ({ v, t: new Date(v.at).getTime() })).filter(x => x.v.visitorId && (FORM_PATH.online.test(x.v.path || "") || FORM_PATH.gym.test(x.v.path || ""))).sort((a, b) => a.t - b.t);

  const proposals = []; // { contactId, vid, program, eventAt }
  for (const run of readJson(RUNS_FILE, [])) {
    const program = programByFlow.get(run.flowId);
    if (!program) continue;
    const t = new Date(run.enteredAt).getTime();
    if (t < FROM_MS || t > TO_MS) continue;
    const contact = contactsById.get(run.contactId);
    if (!contact || trackedContacts.has(contact.id)) continue;
    const cands = new Set();
    for (const x of formVisits) {
      if (x.t < t - WINDOW_BEFORE_MS) continue;
      if (x.t > t + WINDOW_AFTER_MS) break;
      if (FORM_PATH[program].test(x.v.path || "")) cands.add(x.v.visitorId);
    }
    if (cands.size !== 1) continue;
    const vid = [...cands][0];
    const owner = vidOwner.get(vid);
    if (owner && owner !== contact.id) continue; // that visitor already belongs to someone else
    proposals.push({ contactId: contact.id, vid, program, eventAt: run.enteredAt });
  }

  // no visitor may be matched to two contacts, and no contact to two visitors
  const contactsPerVid = new Map(), vidsPerContact = new Map();
  for (const p of proposals) {
    (contactsPerVid.get(p.vid) || contactsPerVid.set(p.vid, new Set()).get(p.vid)).add(p.contactId);
    (vidsPerContact.get(p.contactId) || vidsPerContact.set(p.contactId, new Set()).get(p.contactId)).add(p.vid);
  }
  const accepted = new Map(); // vid -> contactId
  for (const p of proposals) if (contactsPerVid.get(p.vid).size === 1 && vidsPerContact.get(p.contactId).size === 1) accepted.set(p.vid, p);

  if (!accepted.size) { writeFileSync(MARKER, new Date().toISOString()); console.log("[attribution-inference] nothing to link"); return; }
  copyFileSync(join(DATA_DIR, PAGE_VISITS_FILE), BACKUP);
  const changes = [];
  for (const [vid, p] of accepted) {
    let linked = 0, tagged = null;
    for (const v of byVid.get(vid) || []) {
      if (v.contactId) continue;
      v.contactId = p.contactId; v.inferred = "timing"; linked++;
      if (!tagged && visitKey(v)) tagged = visitKey(v);
    }
    changes.push({ contactId: p.contactId, program: p.program, eventAt: p.eventAt, visitorId: vid, visitsLinked: linked, credited: tagged });
  }
  writeJson(PAGE_VISITS_FILE, visits);
  writeFileSync(REPORT, JSON.stringify({ ranAt: new Date().toISOString(), rule: "exactly one visitor on the form page in the 10 min before the submit", linked: changes.length, changes }, null, 2));
  writeFileSync(MARKER, new Date().toISOString());
  const withAd = changes.filter(c => c.credited && /^(meta-ad|google-ad|ad):/.test(c.credited)).length;
  console.log(`[attribution-inference] linked ${changes.length} sign-ups to a visitor (${withAd} credited to an ad) in ${Date.now() - t0}ms; backup: ${BACKUP}`);
}
