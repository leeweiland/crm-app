// Email block schema + render-to-HTML. This is a pure function used both by
// the campaign/automation-step builder's live preview (a near-identical copy
// runs client-side in block-editor-client.js, since the browser can't import
// this ESM server module directly) and by the actual send-time email body in
// email_backend.js -- keeping the algorithm this simple is what makes it
// practical to keep both copies in sync by hand.
//
// Block shape:
//   { id, type: "text", html, style: {background,border,margin,padding,textAlign} }
//   { id, type: "image", src, link, width, style: {...}, linkAction: null|{type:"add_tag",tagId} }
//   { id, type: "button", text, link, style: {...}, linkAction: null|{type:"add_tag",tagId} }
// Theme: { background, maxWidth }
// linkAction is resolved and executed server-side at click time (see
// email_backend.js's /api/email/click handler) -- it's not rendered into
// the HTML itself, just carried on the block so the click handler can look
// it up by matching the clicked URL back to its source block.

function styleAttr(style) {
  if (!style) return "";
  const parts = [];
  if (style.background) parts.push(`background:${style.background}`);
  if (style.border) parts.push(`border:${style.border}`);
  if (style.margin) parts.push(`margin:${style.margin}`);
  if (style.padding) parts.push(`padding:${style.padding}`);
  if (style.textAlign) parts.push(`text-align:${style.textAlign}`);
  return parts.length ? ` style="${parts.join(";")}"` : "";
}

function renderBlock(block) {
  if (block.type === "text") {
    return `<div${styleAttr(block.style)}>${block.html || ""}</div>`;
  }
  if (block.type === "image") {
    const img = `<img src="${block.src || ""}" width="${block.width || 600}" style="max-width:100%;display:inline-block;border:0"/>`;
    return `<div${styleAttr(block.style)}>${block.link ? `<a href="${block.link}">${img}</a>` : img}</div>`;
  }
  if (block.type === "button") {
    return `<div${styleAttr(block.style)}><a href="${block.link || "#"}" style="display:inline-block;background:#009bff;color:#fff;padding:12px 26px;border-radius:6px;text-decoration:none;font-weight:bold;font-family:sans-serif">${block.text || "Click here"}</a></div>`;
  }
  return "";
}

// Applied wherever a theme value is missing -- both at send time
// (renderEmailBody below) and by the editor's own canvas (block-editor-
// client.js keeps a matching copy), so an email with no explicit theme
// still renders identically in both places instead of each falling back
// to whatever its own context's ambient default happens to be.
export const DEFAULT_THEME = {
  background: "#ffffff",
  maxWidth: 650,
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: 15,
  textColor: "#222222",
  linkColor: "#009bff",
  lineHeight: 1.5,
  bodyPadding: 24,
};

export function renderBlocksToHtml(blocks, theme) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) };
  const body = renderBlocksInner(blocks);
  return `<div style="background:${t.background};padding:${t.bodyPadding}px 0;font-family:${t.fontFamily};font-size:${t.fontSize}px;line-height:${t.lineHeight};color:${t.textColor}"><div style="max-width:${t.maxWidth}px;margin:0 auto;background:#ffffff">${body}</div></div>`;
}

// The actual send-time renderer -- body and footer blocks share ONE wrapper
// (one background/padding/max-width/font container), not two independently
// closed ones. They used to be built and concatenated separately, which
// left the footer with no width constraint of its own once its own inner
// wrapper was removed (see resolveFooterHtml in email_backend.js) -- it
// rendered full-bleed instead of matching the body's column width.
export function renderEmailBody(bodyBlocks, footerHtml, theme) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) };
  const body = renderBlocksInner(bodyBlocks);
  let wrapped = `<div style="background:${t.background};padding:${t.bodyPadding}px 0;font-family:${t.fontFamily};font-size:${t.fontSize}px;line-height:${t.lineHeight};color:${t.textColor}"><div style="max-width:${t.maxWidth}px;margin:0 auto;background:#ffffff">${body}${footerHtml || ""}</div></div>`;
  // Run before applyDefaultLinkColor -- a bare (unlinked) email address in
  // plain text gets auto-detected and auto-linkified by Gmail/etc. with
  // their OWN default blue once the email actually arrives, regardless of
  // the surrounding text's color (this is a client-side rendering step, not
  // something in the HTML we sent -- happened even inside the muted-gray
  // footer disclaimer). Pre-empting it with a real link the color:inherit's
  // from wherever it sits stops the recipient's client from re-styling it.
  wrapped = autoLinkPlainEmails(wrapped);
  // Applied to the WHOLE rendered email (body and footer both) -- an
  // address typed directly into any text block's own content (not just a
  // template's dedicated physicalAddress field) gets the same treatment.
  // Broad on purpose: a "digits + capitalized word" match is a loose
  // heuristic (would also fire on plain sentences like "2024 Was Great"),
  // but the character it inserts is invisible either way, so a false match
  // costs nothing -- there's no real content this needs to avoid touching.
  wrapped = breakAddressPatterns(wrapped);
  return applyDefaultLinkColor(wrapped, t.linkColor);
}

function autoLinkPlainEmails(html) {
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  return html.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi).map(part => {
    if (/^<a\b/i.test(part)) return part;
    return part.replace(emailRe, (m) => `<a href="mailto:${m}" style="color:inherit;text-decoration:inherit">${m}</a>`);
  }).join("");
}

// Gmail (and others) recognize a street address in the raw text and apply
// their own "smart chip" styling/link client-side, after the email
// arrives -- entirely their own rendering step, not something the sent
// HTML controls, and it happens regardless of surrounding color or even an
// existing <a> wrapping the text. A zero-width non-joiner inserted right
// after the leading digit run breaks their pattern match while staying
// genuinely invisible when rendered (same technique buildPreheaderHtml
// uses for the inbox-preview snippet).
function breakAddressPatterns(html) {
  const numberWordRe = /(\d{2,6})(\s+[A-Za-z])/g;
  return html.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi).map(part => {
    if (/^<a\b/i.test(part)) return part;
    return part.replace(numberWordRe, (m, num, tail) => `${num}&zwnj;${tail}`);
  }).join("");
}

// A link gets the theme's link color unless it already carries its own
// explicit color (something a user picked in the Link popover) -- an email
// has no stylesheet to inherit surrounding text color from the way the
// editor's own page CSS does, so an unstyled <a> otherwise falls back to
// whatever blue the recipient's mail client defaults to, not what the
// editor showed.
function applyDefaultLinkColor(html, linkColor) {
  return html.replace(/<a\s+([^>]*?)>/gi, (match, attrs) => {
    if (/style\s*=\s*["'][^"']*color\s*:/i.test(attrs)) return match;
    if (/style\s*=\s*"([^"]*)"/i.test(attrs)) {
      return `<a ${attrs.replace(/style\s*=\s*"([^"]*)"/i, (m2, v) => `style="color:${linkColor};${v}"`)}>`;
    }
    if (/style\s*=\s*'([^']*)'/i.test(attrs)) {
      return `<a ${attrs.replace(/style\s*=\s*'([^']*)'/i, (m2, v) => `style="color:${linkColor};${v}"`)}>`;
    }
    return `<a style="color:${linkColor}" ${attrs}>`;
  });
}

// Just the blocks themselves, no outer canvas/background wrapper -- for
// embedding inside content that already has its own wrapper (the footer,
// appended inside the body's existing canvas rather than starting a second
// nested one).
export function renderBlocksInner(blocks) {
  return (blocks || []).map(renderBlock).join("");
}

// AC-style %TOKEN% merge tags (not {{token}}) so Lee's existing AC email
// templates paste in and work unchanged.
export function applyMergeTags(html, contact) {
  return String(html || "")
    .replace(/%FIRSTNAME%/gi, contact?.first || "")
    .replace(/%LASTNAME%/gi, contact?.last || "")
    .replace(/%EMAIL%/gi, contact?.email || "")
    .replace(/%PHONE%/gi, contact?.phone || "");
}

// Adds an "el=<value>" link-attribution tag directly onto a URL -- "el"
// (not configurable) to match the convention already used everywhere else
// this business tags links by hand (ads, social, YouTube), so CRM-sent
// links read exactly the same way and stay recognizable/short instead of
// pointing through a redirect on this CRM's own domain. The tradeoff,
// explicit and intentional: there's no way to know FOR CERTAIN a specific
// recipient clicked (that would need a redirect, which was tried and
// rejected -- see git history), only that a page visit later showed up
// carrying that campaign's el= value. Uses the URL API instead of string
// concatenation so it correctly handles a link that already has its own
// query string or fragment; a malformed URL is left untouched rather than
// risked being corrupted.
export function appendSourceTag(rawUrl, value) {
  if (!value) return rawUrl;
  if (/^https?:\/\//i.test(rawUrl)) {
    try {
      const u = new URL(rawUrl);
      u.searchParams.set("el", value);
      return u.toString();
    } catch {
      return rawUrl;
    }
  }
  // Protocol-less mention (this app's own SMS templates routinely write
  // "PacificRimAthletics.com/videos/x" with no "https://") -- appended via
  // plain string logic instead of round-tripping through the URL API,
  // which would lowercase the hostname and change how the link reads.
  return `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}el=${encodeURIComponent(value)}`;
}
// Applies appendSourceTag to every <a href="..."> in a rendered email.
export function tagHtmlLinksWithSource(html, value) {
  if (!value) return html;
  return String(html || "").replace(/href="([^"]+)"/g, (match, url) => {
    if (url.startsWith("mailto:") || url.startsWith("#")) return match;
    return `href="${appendSourceTag(url, value)}"`;
  });
}
// Same idea, but for a plain-text SMS body -- finds every URL, WITH or
// WITHOUT a leading http(s)://, and appends the tag to each. Requires a
// trailing "/path" so a bare "info@pacificrimathletics.com" email mention
// (no path after the domain) is never mistaken for a link.
export function appendSourceTagToSmsBody(body, value) {
  if (!value) return body;
  return String(body || "").replace(/(?<!@)(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}\/[^\s]*/g, (url) => appendSourceTag(url, value));
}
