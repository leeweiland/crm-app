import { readJson, writeJson, updateJsonArrayRecordsByIdSet } from "./auth_backend.js";
import { randomUUID } from "crypto";
import { CONTACTS_FILE } from "./segments_shared.js";
import { syncContactFieldsBatch, patchContactIndexRawBatch } from "./sqlite_inbox.js";
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

// The two stored strings for one result -- shared by the contacts-file write and
// the SQLite panel-copy sync so they can never disagree.
export function storedIncomeValues(r) {
  const tag = r.income != null ? `${r.confidence} confidence, AI estimate` : "no estimate, AI";
  return { income: r.income != null ? String(r.income) : "", basis: `${r.basis || "n/a"} [${tag}]` };
}

// results: [{ id, income|null, confidence, basis }] -> written onto the
// contacts in ONE pass over the contacts file. Meant for a handful of contacts
// (the manual "Generate" button = 1): a pass costs about what any contact edit
// does. Thousands go through backchannel/income_fill.mjs instead.
export function applyIncomeEstimates(results) {
  const { incomeId, basisId } = ensureIncomeFields();
  const byId = new Map(results.map(r => [r.id, r]));
  const updated = updateJsonArrayRecordsByIdSet(CONTACTS_FILE, new Set(byId.keys()), c => {
    const v = storedIncomeValues(byId.get(c.id));
    c.customFields = c.customFields || {};
    if (v.income) c.customFields[incomeId] = v.income; else delete c.customFields[incomeId];
    c.customFields[basisId] = v.basis;
    return c;
  });
  try { syncContactFieldsBatch(updated); } catch (e) { console.error("[income_estimate] sqlite sync failed:", e.message); }
  return { requested: results.length, updated: updated.length };
}

// The contact panel reads its contact from the SQLite copy (contacts_idx), which
// backchannel/income_fill.mjs deliberately leaves alone -- so contacts it filled
// showed blank income fields until something edited them. This brings just those
// two custom fields in the copy up to date: one transaction, no contacts-file
// pass, nothing else on the row touched.
export function syncIncomeToPanelCopy(results) {
  const { incomeId, basisId } = ensureIncomeFields();
  const patches = new Map(results.map(r => [r.id, c => {
    const v = storedIncomeValues(r);
    c.customFields = c.customFields || {};
    if (v.income) c.customFields[incomeId] = v.income; else delete c.customFields[incomeId];
    c.customFields[basisId] = v.basis;
  }]));
  return { requested: results.length, synced: patchContactIndexRawBatch(patches) };
}

// The manual "Generate income estimate" button (contact-detail.html). One
// Anthropic call for one contact, only when someone clicks -- nothing runs
// automatically, so the API balance only moves when a person asks. Throws an
// Error carrying an HTTP status for the route to report.
export async function estimateIncomeForContact(contact) {
  const snap = applicationSnapshot(contact, labelIdMap(readJson(CUSTOM_FIELDS_FILE, [])));
  if (!snap) throw Object.assign(new Error("This contact has no application answers (career, current situation, goals...) to estimate from."), { status: 400 });
  const [result] = await estimateIncomeBatch([snap], { concurrency: 1 });
  if (!result) throw Object.assign(new Error("The estimate failed. Check that the Anthropic account has credits, then try again."), { status: 502 });
  applyIncomeEstimates([result]);
  const { incomeId, basisId } = ensureIncomeFields();
  return { ...result, incomeId, basisId, ...storedIncomeValues(result) };
}
