// AI Text email block + %APPLIEDAGO% (2026-11-07).
//
// An "ai" block in the email designer holds instructions instead of copy; at
// send time it becomes a text block written for that one contact from their
// application answers (the contact's custom fields -- GOALS, INJURIES, WHAT
// HAVE THEY TRIED?, etc.). One generation per contact per email, kept in a
// small SQLite file so a resumed/retried send never pays for it twice.
//
// %APPLIEDAGO% reads the contact's "APPLIED WHEN?" field: "12 days ago",
// "4 months ago", "2 years ago" (largest unit that applies), or "a while back"
// when there's no usable date.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "crypto";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { readJson, DATA_DIR } from "./auth_backend.js";
import { retrieveFromCache } from "./data/retrieval.js";

// Lee's writing cache (the same one the AI agents draw on): his real emails,
// newsletters and docs, embedded for retrieval.
const WRITING_CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), "data", "chunks_cache.json");

export const AI_BLOCK_MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5 (best writing)", per1k: "≈ $17 per 1,000 emails" },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", per1k: "≈ $8 per 1,000 emails" },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5 (cheapest)", per1k: "≈ $0.50 per 1,000 emails" },
};
export const DEFAULT_AI_BLOCK_MODEL = "claude-opus-5-5";
export const DEFAULT_AI_BLOCK_PROMPT = "A quick dig into their problems and situation from their application, 1-2 short paragraphs, under 90 words: their pain, injuries, what keeps them stuck, what they've tried that hasn't worked -- and that they're still stuck. Don't tell them things about themselves they already know (their job, height, weight, age, where they live); use those only to understand them. Don't pitch or offer a solution -- the rest of the email does that. It continues straight from the sentence before it (\"...it looks like you applied 3 months ago and...\"), so start mid-thought, lowercase.";

// ── application fields on the contact ────────────────────────────────────
const APPLICATION_LABELS = ["APPLIED WHEN?", "CAREER", "AGE, HEIGHT, WEIGHT, ETC.", "CURRENT SITUATION?", "GOALS", "INJURIES", "WHAT HAVE THEY TRIED?", "WHAT HELP DO THEY WANT?", "READY TODAY?", "READYINESS LEVEL", "STRESS", "PERSONALITY TYPE"];
function contactFieldIdsByLabel() {
  const out = {};
  for (const d of readJson("crm_custom_fields.json", [])) if (d.entityType === "contact") out[String(d.label).trim().toUpperCase()] = d.id;
  return out;
}
export function applicationAnswers(contact) {
  const ids = contactFieldIdsByLabel();
  return APPLICATION_LABELS.map(l => [l, contact?.customFields?.[ids[l]]]).filter(([, v]) => v != null && String(v).trim() !== "");
}

export function appliedAgo(contact, now = Date.now()) {
  const raw = contact?.customFields?.[contactFieldIdsByLabel()["APPLIED WHEN?"]];
  const t = raw ? Date.parse(String(raw).replace(/(\d)(st|nd|rd|th)\b/gi, "$1")) : NaN;
  if (isNaN(t) || t > now) return "a while back";
  const days = Math.floor((now - t) / 86400000);
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (days < 1) return "today";
  if (days < 31) return plural(days, "day");
  if (days < 365) return plural(Math.max(1, Math.floor(days / 30.44)), "month");
  return plural(Math.floor(days / 365.25), "year");
}
export function applyAppliedAgo(text, contact) {
  const s = String(text || "");
  return /%APPLIEDAGO%/i.test(s) ? s.replace(/%APPLIEDAGO%/gi, appliedAgo(contact)) : s;
}

// ── generation ───────────────────────────────────────────────────────────
const SYSTEM = `You write one section of a marketing email from Coach Lee Weiland of Pacific Rim Athletics (bodyweight strength, skill and mobility coaching -- Powerbatics; online worldwide and a gym in Anchorage, Alaska).
Write it AS Lee, in his own voice -- the real emails of his below are the model. Match their rhythm, their "..." pauses, their CAPS for emphasis, their plain blunt phrasing, and reuse his actual words and phrases where they fit. It must read like Lee wrote it himself, never like generic copywriting or AI. Never use: "Here's the thing", "the truth is", "let's be honest", "that's a common trap", "it's not X, it's Y" contrasts, "journey", "game-changer", semicolons. Speak to the reader as "you".
Rules: plain text only -- no greeting, no sign-off, no headings, no lists, no links, no emoji, no em dashes. Separate paragraphs with a blank line. Never shame or insult the reader; their body is the starting point, stated as fact. Never recite their own details back to them (job, height, weight, age, location) -- they know them; talk about their problems instead. Never mention Lee's age. Never invent facts that aren't in their application -- if an answer is missing, stay general rather than guessing. Never mention prices or guarantees.
Return only the section text.`;

// A fixed set of Lee's own writing about being stuck, tight, in pain and
// wasting years -- the same for every recipient, so it sits in the cached part
// of the prompt and costs almost nothing after the first email.
const VOICE_QUERY = "you're stuck, tight, stiff, in pain, tried everything, wasting years, sitting on the sidelines, your training is off, still can't do the moves you want";
const cleanChunk = t => String(t || "").split(/To make sure you keep getting these emails|Blessings!\s*\n?\s*(Coach )?Lee/i)[0].trim();
let voicePack = null;
async function getVoicePack() {
  if (voicePack) return voicePack;
  const seen = new Set(), picked = [];
  for (const ch of await retrieveFromCache(WRITING_CACHE_PATH, VOICE_QUERY, { topN: 40 })) {
    const text = cleanChunk(ch.text), key = text.slice(0, 120);
    if (text.length < 400 || seen.has(key)) continue;
    seen.add(key); picked.push(`--- ${ch.source} ---\n${text}`);
    if (picked.length >= 12) break;
  }
  voicePack = `REAL EMAILS AND WRITING BY LEE (his voice -- write like this):\n\n${picked.join("\n\n")}`;
  return voicePack;
}
// A few more of Lee's passages closest to this person's own problems.
async function relevantPassages(answers) {
  const q = answers.filter(([l]) => /INJUR|TRIED|GOALS|SITUATION|HELP|STRESS/.test(l)).map(([, v]) => String(v).slice(0, 300)).join(" ").slice(0, 1200);
  if (!q) return "";
  try {
    const seen = new Set(), out = [];
    for (const ch of await retrieveFromCache(WRITING_CACHE_PATH, q, { topN: 8 })) {
      const text = cleanChunk(ch.text), key = text.slice(0, 120);
      if (text.length < 300 || seen.has(key)) continue;
      seen.add(key); out.push(`--- ${ch.source} ---\n${text}`);
      if (out.length >= 3) break;
    }
    return out.length ? `Lee's writing closest to this person's problems (same voice):\n\n${out.join("\n\n")}\n\n` : "";
  } catch { return ""; }
}

export async function generateAiParagraph({ prompt, model, contact }) {
  const m = AI_BLOCK_MODELS[model] ? model : DEFAULT_AI_BLOCK_MODEL;
  const answers = applicationAnswers(contact);
  const [pack, near] = await Promise.all([getVoicePack().catch(e => { console.error("[ai-block] voice pack:", e.message); return ""; }), relevantPassages(answers)]);
  const user = `${near}Their application (from our records):\nFirst name: ${contact?.first || "(unknown)"}\nProgram: ${contact?.programType || "(unknown)"}\nApplied: ${appliedAgo(contact)}\n${answers.map(([l, v]) => `${l}: ${String(v).slice(0, 600)}`).join("\n") || "(no application answers on file)"}\n\nWrite this section:\n${prompt || DEFAULT_AI_BLOCK_PROMPT}`;
  const system = pack ? [{ type: "text", text: SYSTEM }, { type: "text", text: pack, cache_control: { type: "ephemeral" } }] : SYSTEM;
  const body = { model: m, max_tokens: 4000, system, messages: [{ role: "user", content: user }], output_config: { effort: "low" } };
  const headers = { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" };
  // Opus/Sonnet 5.5: if a safety classifier declines, the server retries on
  // a fallback model instead of returning nothing.
  if (m !== "claude-haiku-5-5") { body.fallbacks = "default"; headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; }
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Anthropic HTTP ${r.status}`);
  if (d.stop_reason === "refusal") throw new Error("declined by the model");
  const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!text) throw new Error("empty response");
  return text;
}

// ── per-contact cache ────────────────────────────────────────────────────
let _db = null;
function db() {
  if (_db) return _db;
  _db = new DatabaseSync(join(DATA_DIR, "crm_ai_block_cache.db"));
  _db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  _db.exec("CREATE TABLE IF NOT EXISTS ai_block_text (source TEXT NOT NULL, block_id TEXT NOT NULL, contact_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (source, block_id, contact_id))");
  return _db;
}

const escapeHtml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textToHtml = t => String(t).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");

// Bump when the writing setup changes, so cached paragraphs are rewritten.
const GENERATOR_VERSION = "voice-cache-1";
export const hasAiBlocks = blocks => (blocks || []).some(b => b.type === "ai");

// Turns every "ai" block into a text block for this contact. A contact with
// no record (test sends) gets a clearly-marked placeholder; a failed
// generation drops the block rather than holding the whole email (and is
// pushed onto `errors` when the caller passes one). Cached per email, block,
// instructions+model and contact -- a recipient preview writes exactly the
// text the real send then reuses; editing the instructions writes fresh text.
export async function resolveAiBlocks(blocks, { contact, sourceType, sourceId, errors }) {
  if (!hasAiBlocks(blocks)) return blocks;
  const source = `${sourceType || "manual"}:${sourceId || ""}`;
  const out = [];
  for (const b of blocks) {
    if (b.type !== "ai") { out.push(b); continue; }
    const blockKey = `${b.id}:${createHash("sha1").update(`${b.model || ""}|${b.prompt || ""}|${GENERATOR_VERSION}`).digest("hex").slice(0, 12)}`;
    if (!contact) { out.push({ id: b.id, type: "text", style: b.style || {}, html: "<p><i>[AI paragraph -- written for each recipient from their application when the real email sends]</i></p>" }); continue; }
    let text = null;
    try { text = db().prepare("SELECT text FROM ai_block_text WHERE source = ? AND block_id = ? AND contact_id = ?").get(source, blockKey, contact.id)?.text || null; } catch { /* cache is best-effort */ }
    if (!text) {
      try {
        text = await generateAiParagraph({ prompt: b.prompt, model: b.model, contact });
        try { db().prepare("INSERT OR REPLACE INTO ai_block_text (source, block_id, contact_id, text, created_at) VALUES (?, ?, ?, ?, ?)").run(source, blockKey, contact.id, text, new Date().toISOString()); } catch { /* best-effort */ }
      } catch (e) {
        console.error(`[ai-block] ${source} contact ${contact.id}: ${e.message} -- sending without this paragraph`);
        if (errors) errors.push(e.message);
        continue;
      }
    }
    out.push({ id: b.id, type: "text", style: b.style || {}, html: textToHtml(text) });
  }
  return out;
}
