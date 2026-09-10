// "Generate Summary Image" -- a branded, one-page visual recap of a single
// lead's own application data + conversation history, for a coach to
// glance at or share. Two stages:
//   1. Claude reads the raw journey + application answers and picks/writes
//      a short title, overview, subtitle, footer line, and up to 9
//      label/value rows -- the actual judgment call of "what's worth
//      putting on this lead's card" (per the admin-editable prompt below),
//      grounded in Lee's own writing archive so the copy is his voice, not
//      invented marketing text.
//   2. That structured content, plus the full admin prompt as creative
//      direction, gets sent to OpenAI's gpt-image-1 (images.edit, with the
//      real assets/pra-logo.png attached as a reference image) to actually
//      render the finished page. A hand-built SVG template was tried first
//      and produced flat, template-y results nowhere near the production
//      value of real sports-brand marketing collateral -- gpt-image-1 gets
//      much closer, at the cost of exact pixel-level control over text/logo
//      placement.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { CUSTOM_FIELDS_FILE } from "./contacts_backend.js";
import { getContactMessages } from "./message_index.js";
import { formatCustomerJourney } from "./ai_agents_backend.js";
import { retrieveFromCache, formatChunksForPrompt } from "./data/retrieval.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same file ai_agents_backend.js's own writing-cache retrieval already
// reads (kept in sync by its syncWritingCacheIfDue job) -- reused directly
// rather than re-exported from there, since that module doesn't currently
// export its own copy of this path.
const WRITING_CACHE_PATH = join(__dirname, "data", "chunks_cache.json");

export const APP_SUMMARY_SETTINGS_FILE = "crm_app_summary_settings.json";

export const DEFAULT_APP_SUMMARY_PROMPT = `We should be able to take raw text, CRM application data info and put it into here and have it create a nice visual 1 page with Aldrich, Century Gothic, 009bff and MUST USE THE Pacific Rim Athletics logo, all on a black/009bff (and darker shades) color scheme.

Make it custom to this specific person -- their conversation history and application data especially, not a generic template fill. Pull out what actually matters about THEM: their real goals, their real obstacles, what they've already tried, what's motivating them right now. Write the title, overview, subtitle, and footer line like they're speaking to this one person's situation, not a form.

Voice rule: every phrase that ISN'T a direct fact from their own application/conversation (the title, the one-line overview, the subtitle, the footer line) must come from Lee's own writing archive below, not be invented from scratch -- reuse or lightly adapt an actual line/phrase that's really his, in his real voice, rather than writing new generic marketing copy. If nothing retrieved genuinely fits, prefer a shorter, plainer line over inventing a flashy one.

Style: comic-book PANELS (bold bordered sections, angled corner cuts) -- not speech bubbles or anything cartoonish/immature. Pick one athletic silhouette (handstand, planche, pushup, run, or jump) that fits their energy/goals, and one Pacific Rim nature motif (mountain, volcano, or wave) for the background accent.`;

function getAppSummarySettings() {
  return readJson(APP_SUMMARY_SETTINGS_FILE, { prompt: DEFAULT_APP_SUMMARY_PROMPT });
}

let cachedLogoBuffer = null;
function getLogoBuffer() {
  if (cachedLogoBuffer) return cachedLogoBuffer;
  cachedLogoBuffer = readFileSync(join(__dirname, "assets", "pra-logo.png"));
  return cachedLogoBuffer;
}

// Turns the structured content Claude produced into the actual image-
// generation prompt. The full admin prompt is included verbatim as
// creative direction (not just used to steer Claude's text) so editing it
// in settings changes the finished image's look, not only its wording --
// per direct instruction that the creative direction should live entirely
// in the admin-editable prompt.
function buildImagePrompt(adminPrompt, content) {
  const rowsText = content.rows.map((r) => `- ${(r.label || "").toUpperCase()}: ${r.value}`).join("\n");
  return `${adminPrompt}

Now generate ONE single premium, cinematic one-page recap graphic (portrait orientation, full-bleed, one cohesive composition) following that creative direction, using this exact content:

HEADLINE: "${content.title}"
OVERVIEW (short highlighted callout line): "${content.overview}"
SUBTITLE: "${content.subtitle}"
ATHLETE SILHOUETTE POSE to feature prominently: ${content.silhouette}
BACKGROUND NATURE MOTIF: ${content.natureMotif}
INFO PANELS -- render each as its own clearly separated section, in this order, each with a small relevant line-icon, a blue all-caps label, and the value in white text:
${rowsText}
FOOTER BANNER TEXT (bold, centered, blue all-caps): "${content.footerLine}"

Reproduce the attached logo image exactly near the top of the page, paired with the wordmark "PACIFIC RIM ATHLETICS". Render all quoted text exactly as given, legibly, with strong contrast against the background. This should look like professional, expensive sports-brand marketing collateral -- not a cartoon, not a comic strip, no speech bubbles, no childish elements.`;
}

async function generateSummaryImagePng(adminPrompt, content) {
  const prompt = buildImagePrompt(adminPrompt, content);
  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("prompt", prompt);
  form.append("size", "1024x1536");
  form.append("quality", "high");
  form.append("image[]", new Blob([getLogoBuffer()], { type: "image/png" }), "pra-logo.png");

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI image error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image response missing image data");
  return Buffer.from(b64, "base64");
}

const SILHOUETTES = ["handstand", "planche", "pushup", "run", "jump"];
const NATURE_MOTIFS = ["mountain", "volcano", "wave"];

// Grounds the title/overview/subtitle/footer in Lee's own real writing
// instead of letting Claude invent marketing copy from scratch -- reuses
// the exact same retrieval the AI reply agents already use (see
// ai_agents_backend.js's retrieveBoth), just scoped to the writing cache
// only (not the sales-conversation cache, which is transcripts of OTHER
// people's replies, not Lee's own voice). The query is the person's own
// situation in a few words, so what comes back is thematically relevant --
// someone hesitant over money retrieves real lines about overcoming that
// exact kind of hesitation, not a random sample of the whole archive.
async function retrieveWritingGrounding(customFieldsText, journeyBlock) {
  const query = `${customFieldsText}\n${journeyBlock}`.trim().slice(0, 600) || "starting training now, committing to change";
  try {
    const chunks = await retrieveFromCache(WRITING_CACHE_PATH, query, { topN: 8 });
    return chunks.length ? formatChunksForPrompt(chunks, "LEE'S OWN WRITING ARCHIVE -- pull the title/overview/subtitle/footer phrasing from here") : "";
  } catch (e) {
    console.error("[app-summary] writing cache retrieval failed:", e.message);
    return "";
  }
}

async function generateCardContent(prompt, contact, journeyBlock, customFieldsText) {
  const grounding = await retrieveWritingGrounding(customFieldsText, journeyBlock);
  const userText = `APPLICATION / CUSTOM FIELDS:\n${customFieldsText || "(none on file)"}\n\nCONVERSATION HISTORY:\n${journeyBlock || "(no conversation history yet)"}\n\nCore info: ${contact.first || ""} ${contact.last || ""}, ${contact.programType || "unknown"} lead, status ${contact.status || "unknown"}.${grounding}`;
  const system = `${prompt}\n\nRespond with ONLY a JSON object, no markdown fences, no commentary, shaped exactly like:\n{"title": "short punchy 2-5 word title, adapted from the writing archive", "overview": "one short punchy line -- the single biggest takeaway on this person, at a glance", "subtitle": "one sentence tailored to this person, adapted from the writing archive", "footerLine": "one short closing line, adapted from the writing archive", "silhouette": "one of: ${SILHOUETTES.join(", ")}", "natureMotif": "one of: ${NATURE_MOTIFS.join(", ")}", "rows": [{"label": "SHORT LABEL", "value": "concise value, one sentence max"}, ...]}\nUse 6 to 9 rows. Every row must be genuinely grounded in the application data or conversation supplied -- never invent a detail that isn't in it. Keep every value short enough to read at a glance (under ~90 characters). silhouette and natureMotif must be exactly one of the listed options, lowercase. The entire response must be valid JSON on a single line -- every string value must be a single line with no literal line breaks in it (use a space instead), and any literal double-quote or backslash inside a value must be escaped.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 4096, system, messages: [{ role: "user", content: userText }] }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).find((b) => b.type === "text")?.text || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let jsonText = jsonMatch ? jsonMatch[0] : text;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Claude occasionally puts a literal line break inside a string value
    // (a real newline instead of an escaped \n) -- confirmed live, this is
    // the one thing that reliably breaks JSON.parse here. Every value on
    // this card is meant to read as one short line anyway, so collapsing
    // any stray newline/tab to a single space is a safe fix, not a
    // meaning-changing one -- retry once with that repair before giving up.
    jsonText = jsonText.replace(/[\r\n\t]+/g, " ");
    parsed = JSON.parse(jsonText);
  }
  return {
    title: parsed.title || "YOUR NEXT CHAPTER",
    overview: parsed.overview || "",
    subtitle: parsed.subtitle || "",
    footerLine: parsed.footerLine || "A STRONGER YOU IS ALWAYS POSSIBLE",
    silhouette: SILHOUETTES.includes(parsed.silhouette) ? parsed.silhouette : SILHOUETTES[Math.floor(Math.random() * SILHOUETTES.length)],
    natureMotif: NATURE_MOTIFS.includes(parsed.natureMotif) ? parsed.natureMotif : NATURE_MOTIFS[Math.floor(Math.random() * NATURE_MOTIFS.length)],
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
  };
}

export async function handleAppSummaryRequest(req, res, url) {
  const p = url.pathname;

  if (p === "/api/app-summary/prompt" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    return sendJson(res, 200, { ...getAppSummarySettings(), default: DEFAULT_APP_SUMMARY_PROMPT });
  }

  if (p === "/api/app-summary/prompt" && req.method === "PUT") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const { prompt } = await readJsonBody(req);
    const settings = { prompt: String(prompt || "").trim() || DEFAULT_APP_SUMMARY_PROMPT };
    writeJson(APP_SUMMARY_SETTINGS_FILE, settings);
    return sendJson(res, 200, { ok: true, ...settings });
  }

  const genMatch = p.match(/^\/api\/contacts\/([^/]+)\/summary-image$/);
  if (genMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!process.env.ANTHROPIC_API_KEY) return sendJson(res, 400, { error: "ANTHROPIC_API_KEY isn't set" });
    if (!process.env.OPENAI_API_KEY) return sendJson(res, 400, { error: "OPENAI_API_KEY isn't set" });
    const contactId = genMatch[1];
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact) return sendJson(res, 404, { error: "Contact not found" });

    const fieldDefs = readJson(CUSTOM_FIELDS_FILE, []);
    const fieldLabel = new Map(fieldDefs.map((f) => [f.id, f.label]));
    const customFieldsText = Object.entries(contact.customFields || {})
      .filter(([, v]) => v !== "" && v != null)
      .map(([id, v]) => `${fieldLabel.get(id) || id}: ${v}`)
      .join("\n");

    const journey = getContactMessages(contactId);
    const journeyBlock = formatCustomerJourney(contact, journey);
    const { prompt } = getAppSummarySettings();

    try {
      const content = await generateCardContent(prompt, contact, journeyBlock, customFieldsText);
      const png = await generateSummaryImagePng(prompt, content);
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(png);
      return true;
    } catch (e) {
      console.error("[app-summary] generation failed:", e.message);
      return sendJson(res, 500, { error: e.message });
    }
  }

  return false;
}
