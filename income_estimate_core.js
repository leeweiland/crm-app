// Pure (no app imports, no file access) half of the income estimator: the
// rubric, the Anthropic call, and the application-text extraction. Kept apart
// from income_estimate.js -- which touches the contacts file, custom fields and
// SQLite -- so a one-off batch script can import just this and run against
// production credentials without booting any of the app's own data modules.

// Custom fields exist in two flavours for the same question -- "contact" and
// the older "lead" entity type (1,611 production contacts still carry answers
// under the lead-entity ids), so every lookup below is by LABEL across both.
const APPLICATION_LABELS = ["CAREER", "CURRENT SITUATION?", "GOALS", "WHAT HAVE THEY TRIED?", "WHAT HELP DO THEY WANT?", "AGE, HEIGHT, WEIGHT, ETC."];
// Text a contact needs at least one of before there is anything to estimate
// from. The blurb field (AGE, HEIGHT, WEIGHT, ETC.) alone doesn't count: it's
// body stats, and only occasionally mentions a job.
const CORE_LABELS = ["CAREER", "CURRENT SITUATION?", "GOALS", "WHAT HAVE THEY TRIED?", "WHAT HELP DO THEY WANT?"];

export const MODEL = "claude-sonnet-5";
export const BATCH_SIZE = 20;

export function labelIdMap(customFields) {
  const map = {};
  for (const f of customFields || []) (map[f.label] = map[f.label] || []).push(f.id);
  return map;
}
function fieldText(contact, ids) {
  const cf = contact.customFields || {};
  return (ids || []).map(id => String(cf[id] ?? "").trim()).filter(Boolean).join(" / ");
}
// { id, text } for the estimator, or null when the contact has no application
// text at all.
export function applicationSnapshot(contact, labelMap) {
  let hasCore = CORE_LABELS.some(l => fieldText(contact, labelMap[l]));
  const parts = [];
  for (const l of APPLICATION_LABELS) {
    const t = fieldText(contact, labelMap[l]);
    if (t) parts.push(`${l.replace(/\?$/, "")}: ${t.slice(0, 500)}`);
  }
  // Answers saved by the CRM's own forms/booking pages whose question wasn't
  // mapped to a real custom field land under an auto-made key built from the
  // question text ("career_if_you_re_retired_please_put_what_you_did") --
  // recent online leads carry them, so read those too.
  for (const [k, v] of Object.entries(contact.customFields || {})) {
    if (!/^(career|current_situation|what_have_you_tried|why_is_it_important)/.test(k)) continue;
    const t = String(v ?? "").trim();
    if (!t) continue;
    parts.push(`${k.replace(/_/g, " ").slice(0, 60)}: ${t.slice(0, 500)}`);
    hasCore = true;
  }
  return hasCore ? { id: contact.id, text: parts.join("\n").slice(0, 1600) } : null;
}

const RUBRIC = `You estimate how much money a fitness-coaching lead earns per year, using only what they wrote on their application.

For each lead, output the most likely CURRENT annual gross personal income in US dollars.

How to estimate:
- Assume the United States unless the text clearly says otherwise. Use typical market pay for the stated occupation, adjusted for any seniority clue (owner/founder of a real business, senior, lead, director, self-employed with real details, part-time, apprentice).
- Explicit statements about their own money outweigh the job title: "no money right now", "on a budget", "can't afford it", "unemployed", "laid off" mean LOW income; "six figures", a named high-earning business, or stated revenue mean what they say.
- Retired: use realistic retirement income (about 40000) unless they state pension/business income. Student, unemployed, stay-at-home: 20000 or less.
- Self-employed / entrepreneur / business owner / "own my own business" WITH real detail (what it is, how big): estimate from that. With NO detail at all: return null.
- Junk, gibberish, or an answer that isn't an occupation ("Over 18", "No", "Nothing", a phone number, one word that isn't a job): return null.
- Round to the nearest 5000.

Give each lead:
- "income": integer USD per year, or null when you truly can't estimate
- "confidence": "high" (clear occupation with a well-known pay band), "medium", or "low"
- "basis": at most 14 words naming the cue you used (e.g. "Physician; typical pay well above 200k")

Respond with ONLY a JSON array, one object per lead, in the same order: [{"id":"...","income":85000,"confidence":"medium","basis":"..."}]`;

async function callModel(items) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const userMsg = items.map(it => `### LEAD ${it.id}\n${it.text}`).join("\n\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: RUBRIC, messages: [{ role: "user", content: userMsg }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) { const e = new Error(`Anthropic error ${r.status}: ${(await r.text()).slice(0, 300)}`); e.status = r.status; throw e; }
  const d = await r.json();
  const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("no JSON array in model reply");
  return JSON.parse(text.slice(start, end + 1));
}

function cleanResult(raw, id) {
  const income = Number.isFinite(Number(raw?.income)) && raw.income !== null ? Math.round(Number(raw.income) / 5000) * 5000 : null;
  const confidence = ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "low";
  const basis = String(raw?.basis || "").replace(/\s+/g, " ").trim().slice(0, 160) || (income == null ? "not enough information" : "");
  return { id, income: income != null && income >= 0 ? income : null, confidence, basis };
}

// items: [{ id, text }] (any length -- split into BATCH_SIZE calls, retried).
// Returns a result per item that got an answer; an item the model skipped or a
// batch that kept failing is simply absent, so the caller can retry it later.
export async function estimateIncomeBatch(items, { concurrency = 4, onProgress } = {}) {
  const chunks = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) chunks.push(items.slice(i, i + BATCH_SIZE));
  const out = [];
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      let reply = null;
      for (let attempt = 1; attempt <= 4 && !reply; attempt++) {
        try { reply = await callModel(chunk); }
        catch (e) {
          if (attempt === 4 || (e.status && e.status < 500 && e.status !== 429)) { console.error("[income_estimate] batch failed:", e.message); break; }
          await new Promise(r => setTimeout(r, 1500 * attempt * attempt));
        }
      }
      if (!reply) continue;
      const byId = new Map(reply.map(x => [String(x?.id), x]));
      chunk.forEach((it, i) => {
        const raw = byId.get(it.id) || (reply.length === chunk.length ? reply[i] : null);
        if (raw) out.push(cleanResult(raw, it.id));
      });
      onProgress?.(out.length, items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
