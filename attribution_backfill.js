// ONE-TIME passes (2026-09-19): link older sign-ups to the ad-click visit that most
// likely brought them, ONLY where the evidence is unambiguous.
//
// Why: Sep 2-15 the site's visits were recorded but the sign-up was never tied
// to the visitor (the submit beacon that does that only exists since Sep 13 and
// the click was lost with the page-visit beacon bug -- see tracking_backend.js).
// The old sign-up data carries no visitor ID, so the only signals left are the
// visits themselves and time.
//
// Pass 1 ("timing"): exactly ONE distinct visitor viewed that program's form page
//   (/online-reg*, /gym-reg*) in the 10 minutes before the submit (or up to 1 minute after).
// Pass 2 ("timing+landing"): among visitors who viewed the form page in the 10 minutes
//   before the submit, exactly ONE also loaded that program's landing page (/online, /gym)
//   from 10s before to 60s after the submit -- the redirect right after the form
//   (median 4s after for sign-ups whose visitor is known for certain). Scored against
//   sign-ups with a known visitor: 11 of 12 unique picks correct.
// Both passes only apply to an ONLINE EMAIL / GYM EMAIL event (a "1 ONLINE LEAD"/
// "1 GYM LEAD" flow run) whose contact has no click journey linked yet, and skip a
// match unless: that visitor isn't already linked to a different contact, and no
// visitor is matched to two contacts nor a contact to two visitors.
// Every visit linked is tagged `inferred: "<pass>"`, so the report/journeys can say
// so and it can be undone. A backup of the visits file and a per-match report are
// written next to the data for each pass.
import { existsSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { readJson, writeJson, DATA_DIR } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { PAGE_VISITS_FILE } from "./tracking_backend.js";
import { FLOWS_FILE, RUNS_FILE } from "./flows_backend.js";

const FROM_MS = Date.parse("2026-09-02T00:00:00Z"), TO_MS = Date.parse("2026-09-16T08:00:00Z"); // through the Sep 15 Anchorage day
const WINDOW_BEFORE_MS = 10 * 60000, WINDOW_AFTER_MS = 60000;
const FORM_PATH = { online: /^\/online-reg/, gym: /^\/gym-reg/ };
const LANDING_PATH = { online: /^\/online(\/|\?|$)/, gym: /^\/gym(\/|\?|$)/ };

function visitKey(v) {
  if (v.el) return v.el;
  let p; try { p = new URLSearchParams(v.search || ""); } catch { return null; }
  const h = p.get("h_ad_id");
  if (h) return p.get("fbc_id") ? `meta-ad:${h}` : p.get("gc_id") ? `google-ad:${h}` : `ad:${h}`;
  return null;
}

// candidates(program, tMs, ctx) -> Set of visitor ids for one sign-up event
const PASSES = {
  timing: {
    file: "2026-09-19", // markers/report names kept from the first run
    candidates: (program, t, { formVisits }) => {
      const s = new Set();
      for (const x of formVisits) {
        if (x.t < t - WINDOW_BEFORE_MS) continue;
        if (x.t > t + WINDOW_AFTER_MS) break;
        if (FORM_PATH[program].test(x.v.path || "")) s.add(x.v.visitorId);
      }
      return s;
    },
    rule: "exactly one visitor on the form page in the 10 min before the submit",
  },
  "timing+landing": {
    file: "2026-09-19_landing",
    candidates: (program, t, ctx) => {
      const onForm = PASSES.timing.candidates(program, t, ctx);
      if (!onForm.size) return onForm;
      const landed = new Set();
      for (const x of ctx.landingVisits) {
        if (x.t < t - 10000) continue;
        if (x.t > t + 60000) break;
        if (LANDING_PATH[program].test(x.v.path || "")) landed.add(x.v.visitorId);
      }
      return new Set([...onForm].filter(vid => landed.has(vid)));
    },
    rule: "exactly one visitor who was on the form page in the 10 min before the submit AND loaded the landing page within 10s before to 60s after it",
  },
};

function runPass(name) {
  const pass = PASSES[name];
  const MARKER = join(DATA_DIR, `_attribution_inferred_${pass.file}.done`);
  const REPORT = join(DATA_DIR, `_attribution_inferred_${pass.file}_report.json`);
  const BACKUP = join(DATA_DIR, `_page_visits_before_inference_${pass.file}.json`);
  if (existsSync(MARKER)) return;
  const t0 = Date.now();
  const flows = readJson(FLOWS_FILE, []);
  const findFlowId = (needle) => flows.find(f => (f.name || "").toUpperCase().includes(needle))?.id || null;
  const programByFlow = new Map([[findFlowId("ONLINE LEAD"), "online"], [findFlowId("GYM LEAD"), "gym"]].filter(([id]) => id));
  const visits = readJson(PAGE_VISITS_FILE, []);
  const contacts = readJson(CONTACTS_FILE, []);
  const contactsById = new Map(contacts.filter(c => !c.testContact).map(c => [c.id, c]));

  const byVid = new Map(), vidOwner = new Map(), trackedContacts = new Set();
  for (const v of visits) {
    if (v.visitorId) {
      (byVid.get(v.visitorId) || byVid.set(v.visitorId, []).get(v.visitorId)).push(v);
      if (v.contactId) vidOwner.set(v.visitorId, v.contactId);
    }
    if (v.contactId && visitKey(v)) trackedContacts.add(v.contactId);
  }
  const timed = visits.map(v => ({ v, t: new Date(v.at).getTime() })).filter(x => x.v.visitorId).sort((a, b) => a.t - b.t);
  const ctx = {
    formVisits: timed.filter(x => FORM_PATH.online.test(x.v.path || "") || FORM_PATH.gym.test(x.v.path || "")),
    landingVisits: timed.filter(x => LANDING_PATH.online.test(x.v.path || "") || LANDING_PATH.gym.test(x.v.path || "")),
  };

  const proposals = [];
  for (const run of readJson(RUNS_FILE, [])) {
    const program = programByFlow.get(run.flowId);
    if (!program) continue;
    const t = new Date(run.enteredAt).getTime();
    if (t < FROM_MS || t > TO_MS) continue;
    const contact = contactsById.get(run.contactId);
    if (!contact || trackedContacts.has(contact.id)) continue;
    const cands = pass.candidates(program, t, ctx);
    if (cands.size !== 1) continue;
    const vid = [...cands][0];
    const owner = vidOwner.get(vid);
    if (owner && owner !== contact.id) continue; // that visitor already belongs to someone else
    proposals.push({ contactId: contact.id, vid, program, eventAt: run.enteredAt });
  }

  const contactsPerVid = new Map(), vidsPerContact = new Map();
  for (const p of proposals) {
    (contactsPerVid.get(p.vid) || contactsPerVid.set(p.vid, new Set()).get(p.vid)).add(p.contactId);
    (vidsPerContact.get(p.contactId) || vidsPerContact.set(p.contactId, new Set()).get(p.contactId)).add(p.vid);
  }
  const accepted = new Map();
  for (const p of proposals) if (contactsPerVid.get(p.vid).size === 1 && vidsPerContact.get(p.contactId).size === 1) accepted.set(p.vid, p);

  if (!accepted.size) { writeFileSync(MARKER, new Date().toISOString()); console.log(`[attribution-inference:${name}] nothing to link`); return; }
  copyFileSync(join(DATA_DIR, PAGE_VISITS_FILE), BACKUP);
  const changes = [];
  for (const [vid, p] of accepted) {
    let linked = 0, tagged = null;
    for (const v of byVid.get(vid) || []) {
      if (v.contactId) continue;
      v.contactId = p.contactId; v.inferred = name; linked++;
      if (!tagged && visitKey(v)) tagged = visitKey(v);
    }
    changes.push({ contactId: p.contactId, program: p.program, eventAt: p.eventAt, visitorId: vid, visitsLinked: linked, credited: tagged });
  }
  writeJson(PAGE_VISITS_FILE, visits);
  writeFileSync(REPORT, JSON.stringify({ ranAt: new Date().toISOString(), pass: name, rule: pass.rule, linked: changes.length, changes }, null, 2));
  writeFileSync(MARKER, new Date().toISOString());
  const withAd = changes.filter(c => c.credited && /^(meta-ad|google-ad|ad):/.test(c.credited)).length;
  console.log(`[attribution-inference:${name}] linked ${changes.length} sign-ups to a visitor (${withAd} credited to an ad) in ${Date.now() - t0}ms; backup: ${BACKUP}`);
}

export function runInferredAttributionBackfill() {
  runPass("timing");
  runPass("timing+landing");
}
