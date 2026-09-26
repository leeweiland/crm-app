// ONE-TIME seed: replaces the old hardcoded enrollment-recording logic
// (calls_sheet_backend.js's now-deleted /enroll-sheet endpoint) with a real,
// fully-editable Flow -- a "contact's status changes to ENROLLED" trigger,
// branching online/gym via an If/Then on programType, each side finding/
// updating a row in the CALLS TRACKING sheet via a sheet_upsert step. Built
// from whatever crm_integrations.json's old enrollSheet settings and
// ads.callsSheetId already had, so the transition doesn't lose anyone's
// prior configuration -- after this runs, the flow's own spreadsheetId is an
// independent copy (same as any other flow's google_sheet/sheet_upsert
// step), not linked to Settings > Ads' own sheet ID going forward.
//
// Created INACTIVE, same as seed_kickoff_flows.js -- flip it on (and remove
// the old code path, if it's still around) only once its logic has been
// verified. Runs at boot, in-process, once (marker file).
import { randomUUID } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { readJson, writeJson, DATA_DIR } from "./auth_backend.js";

const FLOWS_FILE = "crm_flows.json";
const INTEGRATIONS_FILE = "crm_integrations.json";
const DEFAULT_CALLS_SHEET_ID = "1ue2wI4Nm5StnRhOSCYvMCjwiDMgqnWOuifGWbUQB92w";
const DEFAULT_SHEET_TABS = { online: "ONLINE", gym: "GYM" };
const DEFAULT_COLUMN_NAMES = {
  first: "First", last: "Last", email: "Email", phone: "Phone",
  qualified: "Qualified", result: "Result", program: "Program",
  amountPaid: "Amount Paid", payment: "Payment", notes: "Notes",
  startDate: "Start Date", endDate: "End Date", enrollmentDate: "Date Of Enrollment",
};
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const stepId = () => "st" + Array.from({ length: 8 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");

// Real custom-field IDs on this account (crm_custom_fields.json) -- the same
// START DATE/END DATE fields the contact detail panel's intake section shows,
// and that sqlite_inbox.js's renewal-alert stamping already reads. Keeps the
// contact record itself in sync with what's going into the sheet, not just
// the external spreadsheet.
const START_DATE_FIELD_ID = "4e47ce5a-087d-44e6-85e1-e47eb54ac669";
const END_DATE_FIELD_ID = "d49b092b-3054-4d5c-b7fa-d4ac32e9df3b";

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

function sheetUpsertStep(sheetName, columnNames, nextStepId) {
  const id = stepId();
  return {
    id, type: "sheet_upsert",
    config: {
      spreadsheetId: "", spreadsheetName: "", sheetName,
      matchGroups: [
        { fields: [{ contactField: "email", header: columnNames.email }] },
        { fields: [{ contactField: "phone", header: columnNames.phone }] },
        { fields: [{ contactField: "first", header: columnNames.first }, { contactField: "last", header: columnNames.last }] },
      ],
      columns: [
        // First/Last/Email/Phone matter on the APPEND path (a matched row
        // already has these; a brand-new row wouldn't get them at all
        // without an explicit column for each, unlike the old hardcoded
        // endpoint this replaces, which always included them).
        { header: columnNames.first, value: "{{first}}" },
        { header: columnNames.last, value: "{{last}}" },
        { header: columnNames.email, value: "{{email}}" },
        { header: columnNames.phone, value: "{{phone}}" },
        { header: columnNames.qualified, value: "Qualified" },
        { header: columnNames.result, value: "Enrolled" },
        { header: columnNames.program, value: "{{customFields.enrollProgram}}" },
        { header: columnNames.amountPaid, value: "{{customFields.enrollAmountPaid}}" },
        { header: columnNames.payment, value: "{{customFields.enrollPayment}}" },
        { header: columnNames.notes, value: "{{customFields.enrollNotesFormatted}}" },
        { header: columnNames.startDate, value: "{{customFields.enrollStartDate}}" },
        { header: columnNames.endDate, value: "{{customFields.enrollEndDate}}" },
        { header: columnNames.enrollmentDate, value: "{{customFields.enrollDate}}" },
      ],
    },
    nextStepId: nextStepId || null, yesStepId: null, noStepId: null,
  };
}

function buildFlow(sheetId, sheetTabs, columnNames) {
  const onlineDatesStep = updateDatesStep();
  const gymDatesStep = updateDatesStep();
  const onlineStep = sheetUpsertStep(sheetTabs.online, columnNames, onlineDatesStep.id);
  const gymStep = sheetUpsertStep(sheetTabs.gym, columnNames, gymDatesStep.id);
  // The spreadsheet picker in flow-builder.html expects spreadsheetId to be
  // set the same way a human would set it (search -> pick), but this seed
  // pre-fills it directly from the sheet the old settings already pointed
  // at, so nothing has to be re-configured by hand after this migration.
  onlineStep.config.spreadsheetId = sheetId;
  gymStep.config.spreadsheetId = sheetId;
  const ifId = stepId();
  const steps = {
    [ifId]: { id: ifId, type: "if_then", config: { filter: { all: [{ field: "programType", op: "eq", value: "online" }] } }, nextStepId: null, yesStepId: onlineStep.id, noStepId: gymStep.id },
    [onlineStep.id]: onlineStep,
    [gymStep.id]: gymStep,
    [onlineDatesStep.id]: onlineDatesStep,
    [gymDatesStep.id]: gymDatesStep,
  };
  const now = new Date().toISOString();
  return {
    id: randomUUID(), name: "Enrollment Recording (migrated)", active: false,
    trigger: { type: "status_changed", config: { statusId: "ENROLLED" } },
    steps, startStepId: ifId, createdAt: now, updatedAt: now,
  };
}

export function seedEnrollFlow() {
  const marker = join(DATA_DIR, "_seed_enroll_flow_2026-09-25.done");
  if (existsSync(marker)) return;
  const flows = readJson(FLOWS_FILE, []);
  if (flows.some(f => f.name === "Enrollment Recording (migrated)")) { writeFileSync(marker, new Date().toISOString()); return; }
  const integrations = readJson(INTEGRATIONS_FILE, {});
  const s = integrations.enrollSheet || {};
  const sheetId = integrations.ads?.callsSheetId || DEFAULT_CALLS_SHEET_ID;
  const sheetTabs = {
    online: typeof s.sheetTabs?.online === "string" && s.sheetTabs.online.trim() ? s.sheetTabs.online.trim() : DEFAULT_SHEET_TABS.online,
    gym: typeof s.sheetTabs?.gym === "string" && s.sheetTabs.gym.trim() ? s.sheetTabs.gym.trim() : DEFAULT_SHEET_TABS.gym,
  };
  const columnNames = { ...DEFAULT_COLUMN_NAMES, ...(s.columnNames || {}) };
  flows.push(buildFlow(sheetId, sheetTabs, columnNames));
  writeJson(FLOWS_FILE, flows);
  writeFileSync(marker, new Date().toISOString());
  console.log('[seed] created flow (inactive): "Enrollment Recording (migrated)"');
}
