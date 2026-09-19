// ONE-TIME seed (2026-09-19): recreates the two Tally kickoff forms
// (tally.so/r/wbRQJe "ONLINE KICKOFF", tally.so/r/w50PrZ "GYM KICKOFF") as CRM
// forms. Both Tally forms have the identical 17 required questions on a single
// page, a "Submit" button, and redirect to /refer on completion. Runs at boot,
// in-process (same reasoning as phone_backfill.js), and is idempotent by form
// name -- a form that already exists is never touched or duplicated.
import { randomUUID } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { readJson, writeJson, DATA_DIR } from "./auth_backend.js";

const FORMS_FILE = "crm_forms.json";
const REDIRECT_URL = "https://www.pacificrimathletics.com/refer";
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const fieldId = () => "f" + Array.from({ length: 8 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");

// [type, label, code] -- Tally's Phone is international, its dates are real
// date pickers, everything else (Birthday/Age/Height/Weight/T Shirt Size
// included) is a plain text answer there, so the same here.
const QUESTIONS = [
  ["first_name", "First Name", "first_name"],
  ["last_name", "Last Name", "last_name"],
  ["email", "Email", "email"],
  ["phone", "Phone", "phone"],
  ["date", "Start Date", "start_date"],
  ["date", "End Date", "end_date"],
  ["short_text", "Address", "address"],
  ["short_text", "City", "city"],
  ["short_text", "State", "state"],
  ["short_text", "Zip", "zip"],
  ["short_text", "Country", "country"],
  ["short_text", "Birthday", "birthday"],
  ["short_text", "Age", "age"],
  ["short_text", "Height", "height"],
  ["short_text", "Weight", "weight"],
  ["short_text", "Food Restrictions", "food_restrictions"],
  ["short_text", "T Shirt Size", "t_shirt_size"],
];

function buildForm(name) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), name, status: "published",
    fields: QUESTIONS.map(([type, label, code]) => ({ id: fieldId(), type, label, placeholder: "", required: true, helpText: "", labelFontSize: 15, code })),
    settings: { submitButtonText: "Submit", confirmationMessage: "Thanks — we got it!", redirectUrl: REDIRECT_URL, defaultStatus: "", addTagIds: [], addListIds: [] },
    // Tally's own theme on these: black page, #009bff button, white Aldrich text.
    theme: { accentColor: "#009bff", backgroundColor: "#000000", cardBackground: "#000000", textColor: "#ffffff", fontFamily: "aldrich", secondaryFontFamily: "aldrich", borderRadius: "rounded" },
    createdAt: now, updatedAt: now,
  };
}

export function seedKickoffForms() {
  // Run-once: without this, deleting a kickoff form later would just get it
  // recreated on the next boot.
  const marker = join(DATA_DIR, "_seed_kickoff_forms_2026-09-19.done");
  if (existsSync(marker)) return;
  const forms = readJson(FORMS_FILE, []);
  const created = [];
  for (const name of ["ONLINE KICKOFF", "GYM KICKOFF"]) {
    if (forms.some(f => f.name === name)) continue;
    const form = buildForm(name);
    forms.push(form);
    created.push(`${name} (${form.id})`);
  }
  if (created.length) writeJson(FORMS_FILE, forms);
  writeFileSync(marker, new Date().toISOString());
  if (!created.length) return;
  console.log(`[seed] created forms: ${created.join(", ")}`);
}
