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

const W = 1200;
const BLUE = "#009bff";
const DARK_BLUE = "#062033";
const PANEL_FILL = "#050c14";
const ROW_LABEL_SIZE = 22, ROW_VALUE_SIZE = 27, ROW_LINE_HEIGHT = 34;
const FOOTER_H = 100;

// Comic-panel border -- a bordered rect with one corner cut at 45°, the
// classic panel-frame look, deliberately with NO speech bubbles/cartoon
// elements per direct instruction (this is meant to read as a sports
// editorial/graphic-novel panel grid, not a comic strip).
function panelPath(x, y, w, h, cut = 26, corner = "tr") {
  const pts = {
    tr: [[x, y], [x + w - cut, y], [x + w, y + cut], [x + w, y + h], [x, y + h]],
    bl: [[x, y], [x + w, y], [x + w, y + h], [x + cut, y + h], [x, y + h - cut]],
  }[corner];
  return pts.map((p) => p.join(",")).join(" ");
}
function panel(x, y, w, h, { corner = "tr", cut = 26, fillOpacity = 1 } = {}) {
  return `<polygon points="${panelPath(x, y, w, h, cut, corner)}" fill="${PANEL_FILL}" fill-opacity="${fillOpacity}" stroke="${BLUE}" stroke-opacity="0.55" stroke-width="2.5"/>`;
}

// ── Athletic silhouettes -- simple bold pictogram-style figures (Olympic-
// pictogram construction: a head circle + straight rounded limb bars), not
// attempted photorealism. Each is authored in its own local box and
// returned pre-positioned/scaled via a <g transform>.
function bar(x1, y1, x2, y2, thickness, color) {
  const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const length = Math.hypot(x2 - x1, y2 - y1);
  return `<rect x="${x1}" y="${y1 - thickness / 2}" width="${length}" height="${thickness}" rx="${thickness / 2}" fill="${color}" transform="rotate(${angle} ${x1} ${y1})"/>`;
}
function silhouetteMarkup(pose, color) {
  const T = 15; // limb thickness
  switch (pose) {
    case "handstand":
      return `
        <circle cx="60" cy="138" r="13" fill="${color}"/>
        ${bar(50, 128, 32, 152, T, color)}
        ${bar(70, 128, 88, 152, T, color)}
        ${bar(60, 125, 60, 55, T, color)}
        ${bar(60, 55, 42, 8, T, color)}
        ${bar(60, 55, 78, 8, T, color)}`;
    case "planche":
      return `
        <circle cx="30" cy="112" r="13" fill="${color}"/>
        ${bar(30, 125, 22, 150, T, color)}
        ${bar(30, 112, 95, 90, T, color)}
        ${bar(95, 90, 150, 78, T, color)}`;
    case "pushup":
      return `
        <circle cx="24" cy="128" r="13" fill="${color}"/>
        ${bar(24, 138, 20, 155, T, color)}
        ${bar(24, 128, 90, 118, T, color)}
        ${bar(90, 118, 145, 150, T, color)}
        ${bar(55, 133, 48, 155, T, color)}`;
    case "run":
      return `
        <circle cx="72" cy="30" r="13" fill="${color}"/>
        ${bar(72, 43, 55, 95, T, color)}
        ${bar(55, 95, 30, 100, T, color)}
        ${bar(55, 95, 90, 150, T, color)}
        ${bar(65, 60, 100, 45, T, color)}
        ${bar(65, 60, 35, 78, T, color)}`;
    case "jump":
    default:
      return `
        <circle cx="60" cy="25" r="13" fill="${color}"/>
        ${bar(60, 38, 60, 75, T, color)}
        ${bar(60, 75, 30, 110, T, color)}
        ${bar(60, 75, 90, 110, T, color)}
        ${bar(65, 48, 95, 30, T, color)}
        ${bar(55, 48, 25, 65, T, color)}`;
  }
}
function silhouetteSvg(pose, x, y, scale, color, opacity = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" opacity="${opacity}">${silhouetteMarkup(pose, color)}</g>`;
}

// ── Pacific Rim nature motifs -- simple flat backdrop shapes, low-opacity
// so they read as a background texture behind the header panel, never
// competing with the text sitting on top of them.
function natureMotifSvg(motif, w, h) {
  if (motif === "volcano") {
    return `
      <polygon points="${w * 0.05},${h} ${w * 0.32},${h * 0.15} ${w * 0.42},${h * 0.4} ${w * 0.52},${h * 0.15} ${w * 0.8},${h}" fill="${DARK_BLUE}" opacity="0.65"/>
      <circle cx="${w * 0.42}" cy="${h * 0.13}" r="10" fill="${BLUE}" opacity="0.7"/>`;
  }
  if (motif === "wave") {
    return `<path d="M0,${h * 0.75} C ${w * 0.15},${h * 0.55} ${w * 0.35},${h * 0.95} ${w * 0.5},${h * 0.7} C ${w * 0.65},${h * 0.45} ${w * 0.85},${h * 0.9} ${w},${h * 0.65} L ${w},${h} L 0,${h} Z" fill="${DARK_BLUE}" opacity="0.65"/>`;
  }
  // mountain (default)
  return `<polygon points="0,${h} ${w * 0.2},${h * 0.35} ${w * 0.36},${h * 0.6} ${w * 0.55},${h * 0.2} ${w * 0.75},${h * 0.6} ${w * 0.9},${h * 0.4} ${w},${h} " fill="${DARK_BLUE}" opacity="0.65"/>`;
}

// ── Row icons -- small line-style badges matching the app's existing brand
// icon language (thin blue outline glyphs, no filled/solid weight icons --
// this is a bodyweight/mobility brand, so deliberately no dumbbell/barbell
// glyph anywhere). Picked per-row by keyword match against the label so
// admin-authored labels still get a sensible icon without extra config.
function iconGlyph(type, color) {
  const s = { fill: "none", stroke: color, strokeWidth: 1.8 };
  const a = `fill="${s.fill}" stroke="${s.stroke}" stroke-width="${s.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (type) {
    case "monitor":
      return `<rect x="-9" y="-7" width="18" height="12" rx="1.5" ${a}/><line x1="-5" y1="9" x2="5" y2="9" ${a}/><line x1="0" y1="5" x2="0" y2="9" ${a}/>`;
    case "calendar":
      return `<rect x="-9" y="-7" width="18" height="15" rx="2" ${a}/><line x1="-9" y1="-2" x2="9" y2="-2" ${a}/><line x1="-5" y1="-10" x2="-5" y2="-6" ${a}/><line x1="5" y1="-10" x2="5" y2="-6" ${a}/>`;
    case "briefcase":
      return `<rect x="-9" y="-4" width="18" height="13" rx="2" ${a}/><path d="M -4,-4 L -4,-8 L 4,-8 L 4,-4" ${a}/><line x1="-9" y1="2" x2="9" y2="2" ${a}/>`;
    case "person":
      return `<circle cx="0" cy="-4" r="4" ${a}/><path d="M -7,9 C -7,2 7,2 7,9" ${a}/>`;
    case "bolt":
      return `<path d="M 2,-9 L -6,3 L -1,3 L -2,9 L 6,-3 L 1,-3 Z" ${a}/>`;
    case "pulse":
      return `<path d="M 0,7 C -8,-1 -7,-9 0,-4 C 7,-9 8,-1 0,7 Z" ${a}/><path d="M -6,1 L -3,1 L -1,-3 L 1,5 L 3,1 L 6,1" ${a}/>`;
    case "target":
      return `<circle cx="0" cy="0" r="9" ${a}/><circle cx="0" cy="0" r="5" ${a}/><circle cx="0" cy="0" r="1.5" fill="${color}" stroke="none"/>`;
    case "mountain":
      return `<path d="M -9,7 L -2,-6 L 3,1 L 6,-4 L 9,7 Z" ${a}/>`;
    case "flag":
    default:
      return `<line x1="-6" y1="9" x2="-6" y2="-9" ${a}/><path d="M -6,-9 L 7,-6 L 1,-1 L 7,4 L -6,7" ${a}/>`;
  }
}
function pickRowIcon(label) {
  const l = (label || "").toLowerCase();
  if (/type|program|track/.test(l)) return "monitor";
  if (/when|date|applied|since|start/.test(l)) return "calendar";
  if (/career|job|work|occupation/.test(l)) return "briefcase";
  if (/age|height|weight|stats|body/.test(l)) return "person";
  if (/ready|today|urgen|now/.test(l)) return "bolt";
  if (/injur|health|pain|condition/.test(l)) return "pulse";
  if (/goal|target|aim/.test(l)) return "target";
  if (/location|city|region|area/.test(l)) return "mountain";
  return "flag";
}
function iconBadge(cx, cy, iconType, color) {
  return `<g><rect x="${cx - 23}" y="${cy - 23}" width="46" height="46" rx="10" fill="${PANEL_FILL}" stroke="${color}" stroke-opacity="0.6" stroke-width="1.6"/><g transform="translate(${cx} ${cy})">${iconGlyph(iconType, color)}</g></g>`;
}

function buildSvg({ title, overview, subtitle, footerLine, silhouette, natureMotif, rows }) {
  const logo = getLogoDataUri();
  const titleLines = wrapText(title, 20, 2);
  const subtitleLines = wrapText(subtitle, 46, 3);
  const overviewLines = wrapText(overview, 46, 2);
  const PAD = 60;

  // Header height is derived from where the title/overview/subtitle blocks
  // actually land, not a fixed guess -- a guessed constant let the subtitle
  // spill past the header panel's bottom border whenever the title+overview
  // combination ran long, confirmed live in a test render.
  const overviewTop = PAD + 172 + titleLines.length * 58;
  const overviewBoxH = overviewLines.length > 1 ? 78 : 52;
  const subtitleY0 = overviewTop + overviewBoxH + 34;
  const subtitleBottom = subtitleY0 + (subtitleLines.length - 1) * 30;
  const HEADER_H = Math.max(320, subtitleBottom + 40);

  let y = HEADER_H + 50;
  const rowBlocks = [];
  const rowPanelPad = 24;
  const TEXT_X = PAD + 28 + 46 + 20;
  rows.slice(0, 9).forEach((row, idx) => {
    const valueLines = wrapText(row.value, 55, 2);
    const innerH = Math.max(70, ROW_LINE_HEIGHT + valueLines.length * ROW_LINE_HEIGHT + rowPanelPad * 2 - 10);
    rowBlocks.push(`
      ${panel(PAD, y, W - PAD * 2, innerH, { corner: idx % 2 === 0 ? "tr" : "bl", cut: 22 })}
      ${iconBadge(PAD + 28 + 23, y + innerH / 2, pickRowIcon(row.label), BLUE)}
      <text x="${TEXT_X}" y="${y + rowPanelPad + ROW_LABEL_SIZE}" font-family="Aldrich" font-size="${ROW_LABEL_SIZE}" letter-spacing="2" fill="${BLUE}">${escapeXml((row.label || "").toUpperCase())}</text>
      ${valueLines.map((line, i) => `<text x="${TEXT_X}" y="${y + rowPanelPad + ROW_LABEL_SIZE + ROW_LINE_HEIGHT * (i + 1)}" font-family="Poppins" font-size="${ROW_VALUE_SIZE}" fill="#f2f2f2">${escapeXml(line)}</text>`).join("")}
    `);
    y += innerH + 22;
  });

  const H = Math.max(1100, y + FOOTER_H + 40);

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bgGlow" cx="30%" cy="0%" r="75%">
        <stop offset="0%" stop-color="${DARK_BLUE}"/>
        <stop offset="100%" stop-color="#050505"/>
      </radialGradient>
      <clipPath id="headerClip"><polygon points="${panelPath(PAD, PAD, W - PAD * 2, HEADER_H - PAD, 40, "tr")}"/></clipPath>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgGlow)"/>
    <rect width="${W}" height="${H}" fill="none" stroke="${BLUE}" stroke-opacity="0.25" stroke-width="10"/>

    ${panel(PAD, PAD, W - PAD * 2, HEADER_H - PAD, { corner: "tr", cut: 40 })}
    <g clip-path="url(#headerClip)">${natureMotifSvg(natureMotif, W - PAD * 2, HEADER_H - PAD)}</g>
    ${silhouetteSvg(silhouette, W - 340, PAD + 40, 1.7, BLUE, 0.9)}

    ${logo ? `<image href="${logo}" x="${PAD + 30}" y="${PAD + 24}" width="100" height="100"/>` : ""}
    <text x="${PAD + 145}" y="${PAD + 60}" font-family="Aldrich" font-size="24" letter-spacing="3" fill="${BLUE}">PACIFIC RIM ATHLETICS</text>
    <text x="${PAD + 145}" y="${PAD + 88}" font-family="Poppins" font-size="15" letter-spacing="4" fill="#8fb8d6">PEOPLE &#183; PROGRESS &#183; POSSIBILITIES</text>

    ${titleLines.map((line, i) => `<text x="${PAD + 30}" y="${PAD + 160 + i * 58}" font-family="Aldrich" font-size="50" fill="#ffffff">${escapeXml(line)}</text>`).join("")}

    <polygon points="${panelPath(PAD + 30, PAD + 172 + titleLines.length * 58, 560, overviewLines.length > 1 ? 78 : 52, 16, "bl")}" fill="${BLUE}" opacity="0.16" stroke="${BLUE}" stroke-opacity="0.6" stroke-width="1.5"/>
    ${overviewLines.map((line, i) => `<text x="${PAD + 48}" y="${PAD + 172 + titleLines.length * 58 + 32 + i * 26}" font-family="Poppins" font-size="21" font-weight="600" fill="#ffffff">${escapeXml(line)}</text>`).join("")}

    ${subtitleLines.map((line, i) => `<text x="${PAD + 30}" y="${subtitleY0 + i * 30}" font-family="Poppins" font-size="21" fill="${BLUE}">${escapeXml(line)}</text>`).join("")}

    ${rowBlocks.join("")}

    ${panel(PAD, H - FOOTER_H - 20, W - PAD * 2, FOOTER_H, { corner: "bl", cut: 30 })}
    <text x="${W / 2}" y="${H - FOOTER_H / 2 - 8}" text-anchor="middle" font-family="Poppins" font-size="19" font-weight="600" letter-spacing="1" fill="${BLUE}">${escapeXml((footerLine || "").toUpperCase())}</text>
  </svg>`;
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
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 1500, system, messages: [{ role: "user", content: userText }] }),
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
