// ONE-TIME seed (2026-09-19): the CRM equivalents of the two Zapier zaps
// "5 GYM KICKOFF FORM" / "5 ONLINE KICKOFF FORM" (Tally new submission ->
// ActiveCampaign contact + list -> Google Sheets row -> Formatter -> Close
// lead). Built CRM-only, per Lee: the form submission is the trigger, the
// contact is set ENROLLED and put on the STUDENTS list, and one row goes to
// the matching "... KICKOFF / BUYERS" tab. ActiveCampaign, Close and the
// Formatter step are deliberately NOT reproduced (the CRM owns the contact,
// and phone numbers are already normalized at capture -- see phone_util.js).
//
// Created INACTIVE so they don't run alongside the still-live zaps until Lee
// flips them on. Runs at boot, in-process, once (marker) -- see
// seed_kickoff_forms.js for why; needs the forms that seed created.
import { randomUUID } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { readJson, writeJson, DATA_DIR } from "./auth_backend.js";

const FLOWS_FILE = "crm_flows.json";
const SHEET_ID = "1SQPcRayDql4Fe4BJ5kcHUczMzJGCocy6jAblt3hPplI";
const SHEET_NAME = "1. EMAIL LISTS (sh SALES + ONLINE TEAM LEAD + FRONT DESK)";
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const stepId = () => "st" + Array.from({ length: 8 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");

// Sheet header -> value, matched by header name (the two tabs order Email/Phone
// differently). Payload keys are the form's stable field codes.
const HEADER_VALUE = {
  "First Name": "{{first}}", "Last Name": "{{last}}", "Email": "{{email}}", "Phone": "{{phone}}",
  "Start Date": "{{payload.start_date}}", "End Date": "{{payload.end_date}}", "Status": "ENROLLED",
  "Address 1": "{{payload.address}}", "City": "{{payload.city}}", "State": "{{payload.state}}", "Postal Code": "{{payload.zip}}",
  "Country": "{{payload.country}}", "Birthday": "{{payload.birthday}}", "Age": "{{payload.age}}", "Height": "{{payload.height}}",
  "Weight": "{{payload.weight}}", "Restrictions": "{{payload.food_restrictions}}", "T Shirt Size": "{{payload.t_shirt_size}}",
};
const TABS = {
  GYM: { tab: "GYM KICKOFF / BUYERS", headers: ["First Name", "Last Name", "Start Date", "End Date", "Status", "Email", "Phone", "Address 1", "City", "State", "Postal Code", "Country", "Birthday", "Age", "Height", "Weight", "Restrictions", "T Shirt Size", "Clicks"], list: "GYM STUDENTS" },
  ONLINE: { tab: "ONLINE KICKOFF / BUYERS", headers: ["First Name", "Last Name", "Start Date", "End Date", "Status", "Phone", "Email", "Address 1", "City", "State", "Postal Code", "Country", "Birthday", "Age", "Height", "Weight", "Restrictions", "T Shirt Size"], list: "ONLINE STUDENTS" },
};

function buildFlow(kind, form, listId) {
  const t = TABS[kind];
  const ids = [stepId(), stepId(), stepId()];
  const now = new Date().toISOString();
  const steps = {
    [ids[0]]: { id: ids[0], type: "add_update_contact", config: { first: "{{first}}", last: "{{last}}", email: "{{email}}", phone: "{{phone}}", programType: kind, statusId: "ENROLLED", altEmail: "", altPhone: "", customFields: {} }, nextStepId: ids[1], yesStepId: null, noStepId: null },
    [ids[1]]: { id: ids[1], type: "add_to_list", config: { listId }, nextStepId: ids[2], yesStepId: null, noStepId: null },
    [ids[2]]: { id: ids[2], type: "google_sheet", config: { spreadsheetId: SHEET_ID, spreadsheetName: SHEET_NAME, sheetName: t.tab, headers: t.headers, columns: t.headers.map(h => HEADER_VALUE[h] ?? "") }, nextStepId: null, yesStepId: null, noStepId: null },
  };
  return { id: randomUUID(), name: `5 ${kind} KICKOFF FORM`, active: false, trigger: { type: "form_submitted", config: { formId: form.id } }, steps, startStepId: ids[0], createdAt: now, updatedAt: now };
}

export function seedKickoffFlows() {
  const marker = join(DATA_DIR, "_seed_kickoff_flows_2026-09-19.done");
  if (existsSync(marker)) return;
  const forms = readJson("crm_forms.json", []);
  const lists = readJson("crm_lists.json", []);
  const flows = readJson(FLOWS_FILE, []);
  const created = [], missing = [];
  for (const kind of ["GYM", "ONLINE"]) {
    const name = `5 ${kind} KICKOFF FORM`;
    if (flows.some(f => f.name === name)) continue;
    const form = forms.find(f => f.name === `${kind} KICKOFF`);
    const list = lists.find(l => l.name === TABS[kind].list);
    if (!form || !list) { missing.push(`${kind} (${!form ? "form" : "list"} not found)`); continue; }
    flows.push(buildFlow(kind, form, list.id));
    created.push(name);
  }
  if (created.length) writeJson(FLOWS_FILE, flows);
  if (missing.length) { console.error(`[seed] kickoff flows skipped, will retry next boot: ${missing.join(", ")}`); return; }
  writeFileSync(marker, new Date().toISOString());
  if (created.length) console.log(`[seed] created flows (inactive): ${created.join(", ")}`);
}
