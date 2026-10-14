// ONE-TIME seed: adds Renewal and Travel as real, independent sibling flows to
// "3 ENROLLMENT FORM" -- same trigger (status changes to ENROLLED), same
// toggle in enroll-popup.js (NEW/RENEWAL/TRAVEL) decides which one actually
// acts, via a leading "filter" step on customFields.enrollKind (a plain
// ad-hoc key the popup sets, same as its enrollProgram/enrollAmountPaid/etc --
// not a real custom-field definition, see resolveTemplate/evalCondition's
// "customFields." handling, which is a bare property lookup either way).
//
// Both new flows always APPEND a row (sheet_upsert's new alwaysAppend flag) --
// a renewal/travel sale is its own event on a running log (ONLINE/GYM
// RENEWALS & PAYOFFS, ONLINE/GYM TRAVEL), never a correction to a prior row,
// unlike "3 ENROLLMENT FORM"'s find-or-update behavior against the main
// ONLINE/GYM tabs.
//
// Also patches "3 ENROLLMENT FORM" itself (by its live id -- see below) with
// the SAME filter, inverted (enrollKind is NOT any of renewal/travel), so a
// Renewal/Travel submission can't also re-upsert the person's original row in
// the main ONLINE/GYM tabs. An unset/blank enrollKind (every run before this
// field existed, and every "New" submission) still passes through untouched.
//
// Created ACTIVE (unlike seed_enroll_flow.js's original migration) -- these
// are brand new, additive, and the guard on the existing flow makes the three
// mutually exclusive from the very first run.
import { randomUUID } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { readJson, writeJson, DATA_DIR } from "./auth_backend.js";

const FLOWS_FILE = "crm_flows.json";
const INTEGRATIONS_FILE = "crm_integrations.json";
const DEFAULT_CALLS_SHEET_ID = "1ue2wI4Nm5StnRhOSCYvMCjwiDMgqnWOuifGWbUQB92w";
// The live "3 ENROLLMENT FORM" flow's own id (confirmed 2026-10-14) -- the
// most unambiguous way to find THAT SPECIFIC flow to patch, since by the time
// this ever runs again (it's marker-gated, so never twice) the new Renewal/
// Travel flows share its exact trigger shape too and could otherwise be
// mismatched for it.
const KNOWN_ENROLLMENT_FLOW_ID = "cf57bfa9-f66a-4eaa-97be-d45d88767308";
const START_DATE_FIELD_ID = "4e47ce5a-087d-44e6-85e1-e47eb54ac669";
const END_DATE_FIELD_ID = "d49b092b-3054-4d5c-b7fa-d4ac32e9df3b";
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const stepId = () => "st" + Array.from({ length: 8 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");

// id is the caller's to provide (not generated here) -- every OTHER step
// builder in this file generates its own id and is always stored under that
// exact same id, but buildKindFlow needs this step's id BEFORE building it
// (to wire the if_then's nextStepId), so it has to pass one in; a step whose
// own .id disagrees with the key it's stored under in flow.steps is exactly
// the kind of bug flow-builder.html's editor (which re-keys by step.id on
// save) would silently corrupt the next time a human edited it.
function kindFilterStep(id, kind, op, nextStepId) {
  return {
    id, type: "filter",
    config: { filter: { all: [{ field: "customFields.enrollKind", op, value: op === "eq" ? kind : ["renewal", "travel", "manual"] }] } },
    nextStepId: nextStepId || null, yesStepId: null, noStepId: null,
  };
}
function updateDatesStep(nextStepId) {
  const id = stepId();
  return {
    id, type: "add_update_contact",
    config: {
      first: "", last: "", email: "", phone: "", programType: "", statusId: "", altEmail: "", altPhone: "",
      customFields: { [START_DATE_FIELD_ID]: "{{customFields.enrollStartDate}}", [END_DATE_FIELD_ID]: "{{customFields.enrollEndDate}}" },
    },
    nextStepId: nextStepId || null, yesStepId: null, noStepId: null,
  };
}
// columnNames: {first,last,email,phone,startDate,endDate,date,amount} -> the
// RENEWALS & PAYOFFS / TRAVEL tabs' own real headers (see their own comment
// below -- only 8 columns, a strict subset of the main ONLINE/GYM tabs').
function appendSheetStep(sheetName, columnNames, nextStepId) {
  const id = stepId();
  return {
    id, type: "sheet_upsert",
    config: {
      spreadsheetId: "", spreadsheetName: "", sheetName,
      alwaysAppend: true,
      matchGroups: [], // unused -- alwaysAppend skips matching entirely
      columns: [
        { header: columnNames.first, value: "{{first}}" },
        { header: columnNames.last, value: "{{last}}" },
        { header: columnNames.email, value: "{{email}}" },
        { header: columnNames.phone, value: "{{phone}}", digitsOnly: true },
        { header: columnNames.startDate, value: "{{customFields.enrollStartDate}}" },
        { header: columnNames.endDate, value: "{{customFields.enrollEndDate}}" },
        { header: columnNames.date, value: "{{customFields.enrollDate}}" },
        { header: columnNames.amount, value: "{{customFields.enrollAmountPaid}}" },
      ],
    },
    nextStepId: nextStepId || null, yesStepId: null, noStepId: null,
  };
}
// Real headers confirmed live on all 4 tabs (2026-10-14): FIRST, LAST, EMAIL,
// PHONE, START DATE, END DATE, DATE, AMOUNT -- identical on ONLINE and GYM
// (unlike the main tabs, which differ by a Timezone column). Header lookup is
// already trim+lowercase on both sides (sheet_upsert's hdr/column matching),
// so the GYM tabs' own trailing space on "DATE " needs no special-casing here.
const RENEWAL_TRAVEL_COLUMN_NAMES = { first: "FIRST", last: "LAST", email: "EMAIL", phone: "PHONE", startDate: "START DATE", endDate: "END DATE", date: "DATE", amount: "AMOUNT" };

function buildKindFlow({ kind, name, sheetTabs, updateContactDates }) {
  const onlineDatesStep = updateContactDates ? updateDatesStep() : null;
  const gymDatesStep = updateContactDates ? updateDatesStep() : null;
  const onlineStep = appendSheetStep(sheetTabs.online, RENEWAL_TRAVEL_COLUMN_NAMES, onlineDatesStep?.id);
  const gymStep = appendSheetStep(sheetTabs.gym, RENEWAL_TRAVEL_COLUMN_NAMES, gymDatesStep?.id);
  onlineStep.config.spreadsheetId = DEFAULT_CALLS_SHEET_ID;
  gymStep.config.spreadsheetId = DEFAULT_CALLS_SHEET_ID;
  const ifId = stepId();
  const guardId = stepId();
  const steps = {
    [guardId]: kindFilterStep(guardId, kind, "eq", ifId),
    [ifId]: { id: ifId, type: "if_then", config: { filter: { all: [{ field: "programType", op: "eq", value: "online" }] } }, nextStepId: null, yesStepId: onlineStep.id, noStepId: gymStep.id },
    [onlineStep.id]: onlineStep,
    [gymStep.id]: gymStep,
  };
  if (onlineDatesStep) steps[onlineDatesStep.id] = onlineDatesStep;
  if (gymDatesStep) steps[gymDatesStep.id] = gymDatesStep;
  const now = new Date().toISOString();
  return {
    id: randomUUID(), name, active: true,
    trigger: { type: "status_changed", config: { statusId: "ENROLLED" } },
    steps, startStepId: guardId, createdAt: now, updatedAt: now,
  };
}

// Inserts the inverted guard at the FRONT of the existing enrollment flow --
// everything it already does is untouched, just reachable one step later now.
function patchEnrollmentFlow(flows) {
  const flow = flows.find(f => f.id === KNOWN_ENROLLMENT_FLOW_ID)
    || flows.find(f => f.trigger?.type === "status_changed" && f.trigger.config?.statusId === "ENROLLED" && f.name !== "3 RENEWAL FORM" && f.name !== "3 TRAVEL FORM");
  if (!flow) { console.log('[seed] could not find "3 ENROLLMENT FORM" to patch -- skipping (Renewal/Travel flows still get created)'); return; }
  // Idempotency check independent of the marker file (belt-and-suspenders --
  // the marker alone already prevents a second run): skip if this flow's
  // start step is already our guard.
  const already = flow.steps[flow.startStepId]?.type === "filter" && flow.steps[flow.startStepId]?.config?.filter?.all?.[0]?.field === "customFields.enrollKind";
  if (already) { console.log("[seed] enrollment flow already guarded -- skipping"); return; }
  const guardId = stepId();
  const guard = kindFilterStep(guardId, null, "not_any_of", flow.startStepId);
  flow.steps[guard.id] = guard;
  flow.startStepId = guard.id;
  flow.updatedAt = new Date().toISOString();
  console.log(`[seed] inserted enrollKind guard at the front of "${flow.name}" (${flow.id})`);
}

export function seedRenewalTravelFlows() {
  const marker = join(DATA_DIR, "_seed_renewal_travel_flows_2026-10-14.done");
  if (existsSync(marker)) return;
  const flows = readJson(FLOWS_FILE, []);
  if (flows.some(f => f.name === "3 RENEWAL FORM" || f.name === "3 TRAVEL FORM")) { writeFileSync(marker, new Date().toISOString()); return; }
  patchEnrollmentFlow(flows);
  const integrations = readJson(INTEGRATIONS_FILE, {});
  const sheetId = integrations.ads?.callsSheetId || DEFAULT_CALLS_SHEET_ID;
  // Deliberately independent of DEFAULT_CALLS_SHEET_ID above (same "own copy,
  // not linked going forward" reasoning as seed_enroll_flow.js) -- just reads
  // whatever the existing enrollment flow's own sheetId settings already are,
  // for consistency, since they're meant to be the exact same spreadsheet.
  const renewalFlow = buildKindFlow({
    kind: "renewal", name: "3 RENEWAL FORM",
    sheetTabs: { online: "ONLINE RENEWALS & PAYOFFS", gym: "GYM RENEWALS & PAYOFFS" },
    updateContactDates: true, // a renewal IS the contact's new enrollment period
  });
  const travelFlow = buildKindFlow({
    kind: "travel", name: "3 TRAVEL FORM",
    sheetTabs: { online: "ONLINE TRAVEL", gym: "GYM TRAVEL" },
    updateContactDates: false, // trip dates aren't the contact's program enrollment period -- never overwrite those
  });
  for (const f of [renewalFlow, travelFlow]) for (const key of ["online", "gym"]) {
    const stepsOfKind = Object.values(f.steps).filter(s => s.type === "sheet_upsert");
    stepsOfKind.forEach(s => { s.config.spreadsheetId = sheetId; });
  }
  flows.push(renewalFlow, travelFlow);
  writeJson(FLOWS_FILE, flows);
  writeFileSync(marker, new Date().toISOString());
  console.log('[seed] created flows (active): "3 RENEWAL FORM", "3 TRAVEL FORM"');
}
