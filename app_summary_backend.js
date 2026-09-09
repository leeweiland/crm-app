// "Generate Summary Image" -- a branded, one-page visual recap of a single
// lead's own application data + conversation history, for a coach to
// glance at or share. Two stages, deliberately kept separate:
//   1. Claude reads the raw journey + application answers and picks/writes
//      a short title, subtitle, and up to 9 label/value rows -- the actual
//      judgment call of "what's worth putting on this lead's card" (per
//      the admin-editable prompt below).
//   2. That structured result gets dropped into a fixed, hand-built SVG
//      template (not fed back through an image-generation model) and
//      rasterized to PNG. A generative image model can't reliably render
//      exact multi-line text or drop in a real logo file -- this
//      guarantees the brand elements (logo, fonts, colors) are pixel-exact
//      every time, using the same real assets/pra-logo.png already served
//      elsewhere in the app.
//
// Fonts: Aldrich (the app's own established brand font, see settings.html's
// email-theme font picker) is a real open-license Google Font, embedded
// directly. Century Gothic -- also in that same picker -- is Monotype-
// licensed and can't be redistributed with this app, so body/value text
// uses Poppins (an open, similarly geometric sans) as the closest legal
// stand-in. Swap assets/fonts/*.ttf for a licensed Century Gothic file
// later if one's ever purchased; nothing else here would need to change.
//
// @resvg/resvg-js does the actual rasterizing -- a small native/WASM SVG
// renderer, not a headless browser. Deliberately NOT Puppeteer/Playwright:
// this app already had a real production OOM incident today from
// something far lighter than a bundled Chromium, and this whole feature
// only needs to draw text/rects/an image onto a fixed canvas, not run a
// real browser engine.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { CUSTOM_FIELDS_FILE } from "./contacts_backend.js";
import { getContactMessages } from "./message_index.js";
import { formatCustomerJourney } from "./ai_agents_backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const APP_SUMMARY_SETTINGS_FILE = "crm_app_summary_settings.json";

export const DEFAULT_APP_SUMMARY_PROMPT = `We should be able to take raw text, CRM application data info and put it into here and have it create a nice visual 1 page with Aldrich, Century Gothic, 009bff and MUST USE THE Pacific Rim Athletics logo, all on a black/009bff (and darker shades) color scheme.

Make it custom to this specific person -- their conversation history and application data especially, not a generic template fill. Pull out what actually matters about THEM: their real goals, their real obstacles, what they've already tried, what's motivating them right now. Write the title and subtitle like they're speaking to this one person's situation, not a form.`;

function getAppSummarySettings() {
  return readJson(APP_SUMMARY_SETTINGS_FILE, { prompt: DEFAULT_APP_SUMMARY_PROMPT });
}

let cachedLogoDataUri = null;
function getLogoDataUri() {
  if (cachedLogoDataUri) return cachedLogoDataUri;
  try {
    const buf = readFileSync(join(__dirname, "assets", "pra-logo.png"));
    cachedLogoDataUri = `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    // Falls back to text-only branding rather than failing the whole
    // render -- a missing logo file shouldn't block generating the card.
    cachedLogoDataUri = null;
  }
  return cachedLogoDataUri;
}

function escapeXml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Plain-width word wrap -- SVG <text> never wraps on its own. Character-
// count estimate (not real font metrics) is plenty accurate enough at
// these font sizes/weights for deciding a line break; this only has to
// look right at the one canvas size this template actually renders at.
function wrapText(text, maxCharsPerLine, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (next.length > maxCharsPerLine && current) { lines.push(current); current = w; }
    else current = next;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    const consumedWords = lines.join(" ").split(/\s+/).length;
    if (consumedWords < words.length) lines[maxLines - 1] = last.replace(/.{0,3}$/, "...");
  }
  return lines;
}

const W = 1200, H = 1500;
const BLUE = "#009bff";
const DARK_BLUE = "#062033";
const ROW_LABEL_SIZE = 22, ROW_VALUE_SIZE = 27, ROW_LINE_HEIGHT = 34;

function buildSvg({ title, subtitle, rows }) {
  const logo = getLogoDataUri();
  const titleLines = wrapText(title, 22, 2);
  const subtitleLines = wrapText(subtitle, 60, 2);
  // Everything below the header is positioned relative to how much room the
  // title+subtitle actually took -- a fixed y here overlapped the divider/
  // first row whenever the subtitle wrapped to 2 lines (confirmed live in
  // the first test render).
  const titleBottom = 210 + titleLines.length * 62;
  const subtitleBottom = subtitleLines.length ? titleBottom + 34 + subtitleLines.length * 30 : titleBottom;
  const dividerY = subtitleBottom + 40;
  let y = dividerY + 50;
  const rowBlocks = [];
  for (const row of rows.slice(0, 9)) {
    const valueLines = wrapText(row.value, 62, 2);
    const blockHeight = ROW_LINE_HEIGHT + valueLines.length * ROW_LINE_HEIGHT + 22;
    rowBlocks.push(`
      <rect x="90" y="${y - 8}" width="6" height="${blockHeight - 14}" fill="${BLUE}" opacity="0.55"/>
      <text x="118" y="${y + ROW_LABEL_SIZE}" font-family="Aldrich" font-size="${ROW_LABEL_SIZE}" letter-spacing="2" fill="${BLUE}">${escapeXml((row.label || "").toUpperCase())}</text>
      ${valueLines.map((line, i) => `<text x="118" y="${y + ROW_LABEL_SIZE + ROW_LINE_HEIGHT * (i + 1)}" font-family="Poppins" font-size="${ROW_VALUE_SIZE}" fill="#f2f2f2">${escapeXml(line)}</text>`).join("")}
    `);
    y += blockHeight + 20;
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bgGlow" cx="30%" cy="0%" r="75%">
        <stop offset="0%" stop-color="${DARK_BLUE}"/>
        <stop offset="100%" stop-color="#050505"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgGlow)"/>
    <rect width="${W}" height="${H}" fill="none" stroke="${BLUE}" stroke-opacity="0.25" stroke-width="10"/>

    ${logo ? `<image href="${logo}" x="90" y="70" width="110" height="110"/>` : ""}
    <text x="${logo ? 220 : 90}" y="110" font-family="Aldrich" font-size="26" letter-spacing="3" fill="${BLUE}">PACIFIC RIM ATHLETICS</text>
    <text x="${logo ? 220 : 90}" y="140" font-family="Poppins" font-size="16" letter-spacing="4" fill="#8fb8d6">PEOPLE &#183; PROGRESS &#183; POSSIBILITIES</text>

    ${titleLines.map((line, i) => `<text x="90" y="${210 + i * 62}" font-family="Aldrich" font-size="54" fill="#ffffff">${escapeXml(line)}</text>`).join("")}
    ${subtitleLines.map((line, i) => `<text x="90" y="${titleBottom + 34 + i * 30}" font-family="Poppins" font-size="22" fill="${BLUE}">${escapeXml(line)}</text>`).join("")}

    <line x1="90" y1="${dividerY}" x2="${W - 90}" y2="${dividerY}" stroke="${BLUE}" stroke-opacity="0.3" stroke-width="2"/>

    ${rowBlocks.join("")}

    <text x="${W / 2}" y="${H - 70}" text-anchor="middle" font-family="Poppins" font-size="20" font-weight="600" letter-spacing="1" fill="${BLUE}">A STRONGER YOU IS ALWAYS POSSIBLE</text>
  </svg>`;
}

async function generateCardContent(prompt, contact, journeyBlock, customFieldsText) {
  const userText = `APPLICATION / CUSTOM FIELDS:\n${customFieldsText || "(none on file)"}\n\nCONVERSATION HISTORY:\n${journeyBlock || "(no conversation history yet)"}\n\nCore info: ${contact.first || ""} ${contact.last || ""}, ${contact.programType || "unknown"} lead, status ${contact.status || "unknown"}.`;
  const system = `${prompt}\n\nRespond with ONLY a JSON object, no markdown fences, no commentary, shaped exactly like:\n{"title": "short punchy 2-5 word title", "subtitle": "one sentence tailored to this person", "rows": [{"label": "SHORT LABEL", "value": "concise value, one sentence max"}, ...]}\nUse 6 to 9 rows. Every row must be genuinely grounded in the application data or conversation supplied -- never invent a detail that isn't in it. Keep every value short enough to read at a glance (under ~90 characters). The entire response must be valid JSON on a single line -- every string value must be a single line with no literal line breaks in it (use a space instead), and any literal double-quote or backslash inside a value must be escaped.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 1200, system, messages: [{ role: "user", content: userText }] }),
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
    subtitle: parsed.subtitle || "",
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
      const svg = buildSvg(content);
      const { Resvg } = await import("@resvg/resvg-js");
      const fontDir = join(__dirname, "assets", "fonts");
      const resvg = new Resvg(svg, {
        font: {
          fontDirs: [fontDir],
          loadSystemFonts: false,
          defaultFontFamily: "Poppins",
        },
      });
      const png = resvg.render().asPng();
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
