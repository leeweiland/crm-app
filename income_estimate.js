import { readJson, writeJson, updateJsonArrayRecordsByIdSet } from "./auth_backend.js";
import { randomUUID } from "crypto";
import { CONTACTS_FILE } from "./segments_shared.js";
import { syncContactFieldsBatch } from "./sqlite_inbox.js";
import { labelIdMap, applicationSnapshot, estimateIncomeBatch } from "./income_estimate_core.js";

// Estimated income, worked out from what a lead wrote on their application
// (career, current situation, goals...). Two ordinary contact custom fields
// hold the result so segments, the contact panel and exports treat them like
// any other data:
//   ESTIMATED INCOME (USD/YR)  -- a plain number as text ("85000"), blank when
//                                 the application doesn't say enough to guess.
//                                 Segments compare it with the "greater than"
//                                 family of operators (segments_shared.js).
//   INCOME ESTIMATE BASIS      -- one line of why, so a number is never a black
//                                 box ("Physician -- typical $250k+ [high, AI estimate]").
// Every contact that gets looked at ends up with a BASIS (even a "no estimate"
// one), which is also how the job knows not to score the same contact twice.

// Same file name as contacts_backend.js's CUSTOM_FIELDS_FILE -- duplicated
// rather than imported because contacts_backend.js is what wires the routes
// that call into this module (an import back would cycle).
const CUSTOM_FIELDS_FILE = "crm_custom_fields.json";
export const INCOME_FIELD_LABEL = "ESTIMATED INCOME (USD/YR)";
export const INCOME_BASIS_LABEL = "INCOME ESTIMATE BASIS";

export function ensureIncomeFields() {
  const fields = readJson(CUSTOM_FIELDS_FILE, []);
  let changed = false;
  const find = label => fields.find(f => f.label === label && f.entityType === "contact");
  for (const label of [INCOME_FIELD_LABEL, INCOME_BASIS_LABEL]) {
    if (find(label)) continue;
    fields.push({ id: randomUUID(), entityType: "contact", label, type: "text", order: fields.filter(f => f.entityType === "contact").length, createdAt: new Date().toISOString() });
    changed = true;
  }
  if (changed) writeJson(CUSTOM_FIELDS_FILE, fields);
  return { incomeId: find(INCOME_FIELD_LABEL).id, basisId: find(INCOME_BASIS_LABEL).id };
}

// results: [{ id, income|null, confidence, basis }] -> written onto the
// contacts in ONE pass over the contacts file (a per-contact write costs ~5s
// each on production -- see updateJsonArrayRecordsByIdSet).
export function applyIncomeEstimates(results) {
  const { incomeId, basisId } = ensureIncomeFields();
  const byId = new Map(results.map(r => [r.id, r]));
  const updated = updateJsonArrayRecordsByIdSet(CONTACTS_FILE, new Set(byId.keys()), c => {
    const r = byId.get(c.id);
    c.customFields = c.customFields || {};
    if (r.income != null) c.customFields[incomeId] = String(r.income); else delete c.customFields[incomeId];
    const tag = r.income != null ? `${r.confidence} confidence, AI estimate` : "no estimate, AI";
    c.customFields[basisId] = `${r.basis || "n/a"} [${tag}]`;
    return c;
  });
  try { syncContactFieldsBatch(updated); } catch (e) { console.error("[income_estimate] sqlite sync failed:", e.message); }
  return { requested: results.length, updated: updated.length };
}

// Fire-and-forget from the form-submit path: a brand-new application gets its
// estimate within seconds instead of waiting for the next backfill. Never
// throws to the caller -- a failed estimate just leaves the fields blank.
export function estimateIncomeInBackground(contact) {
  (async () => {
    const labelMap = labelIdMap(readJson(CUSTOM_FIELDS_FILE, []));
    const snap = applicationSnapshot(contact, labelMap);
    if (!snap) return;
    const results = await estimateIncomeBatch([snap], { concurrency: 1 });
    if (results.length) applyIncomeEstimates(results);
  })().catch(e => console.error("[income_estimate] background estimate failed:", e.message));
}
