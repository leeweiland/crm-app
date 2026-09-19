// ONE-TIME sync (2026-09-19): Lee created contact custom fields for the
// kickoff data (START DATE, END DATE, BIRTHDAY, AGE, HEIGHT, WEIGHT, FOOD
// RESTRICTIONS, T SHIRT SIZE) and started mapping them on the GYM kickoff
// flow's Add/Update Contact step (Start/End/Birthday/Age/Height, mixing label
// and code tokens). This finishes that mapping on BOTH kickoff flows so they
// carry the same data: every kickoff question that has a contact custom field
// of the same name is mapped, by its stable field code.
//
// Merge, not overwrite: anything else already on the step (other custom
// fields, status, list, sheet columns) is untouched; a mapping to one of
// these fields is only normalized to the code token ({{payload.height}} for
// {{payload.Height}} -- same value, but immune to the question being reworded).
// Runs at boot, in-process, once; retries next boot until both flows exist.
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { readJson, writeJson, DATA_DIR } from "./auth_backend.js";

const norm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
// Sheet/CRM naming differs slightly from the form's labels for these.
const ALIASES = { postalcode: "zip", zipcode: "zip", food: "foodrestrictions", restrictions: "foodrestrictions", tshirt: "tshirtsize" };

export function syncKickoffFlows() {
  const marker = join(DATA_DIR, "_sync_kickoff_flows_2026-09-19.done");
  if (existsSync(marker)) return;
  const forms = readJson("crm_forms.json", []);
  const flows = readJson("crm_flows.json", []);
  const defs = readJson("crm_custom_fields.json", []).filter(d => d.entityType === "contact");
  const targets = [];
  for (const kind of ["GYM", "ONLINE"]) {
    const form = forms.find(f => f.name === `${kind} KICKOFF`);
    const flow = form && flows.find(f => f.trigger?.type === "form_submitted" && f.trigger.config?.formId === form.id);
    const step = flow && Object.values(flow.steps || {}).find(s => s.type === "add_update_contact");
    if (!step) { console.error(`[sync] kickoff flow sync waiting: ${kind} flow/contact step not found yet`); return; }
    targets.push({ kind, form, flow, step });
  }
  let mappedTotal = 0;
  const report = [];
  for (const { kind, form, flow, step } of targets) {
    step.config.customFields = step.config.customFields || {};
    const added = [];
    for (const q of form.fields) {
      if (!q.code || ["first_name", "last_name", "email", "phone"].includes(q.code)) continue; // core contact fields, mapped in the step itself
      const key = ALIASES[norm(q.label)] || norm(q.label);
      const def = defs.find(d => (ALIASES[norm(d.label)] || norm(d.label)) === key);
      if (!def) continue;
      const token = `{{payload.${q.code}}}`;
      if (step.config.customFields[def.id] !== token) { step.config.customFields[def.id] = token; added.push(`${def.label}`); }
    }
    flow.updatedAt = new Date().toISOString();
    mappedTotal += added.length;
    report.push(`${flow.name}: ${Object.keys(step.config.customFields).length} custom fields mapped (${added.length} added/normalized: ${added.join(", ") || "none"})`);
  }
  if (!defs.length) { console.error("[sync] no contact custom fields found yet -- will retry next boot"); return; }
  writeJson("crm_flows.json", flows);
  writeFileSync(marker, new Date().toISOString());
  console.log(`[sync] kickoff flows synced: ${report.join(" | ")}`);
}
