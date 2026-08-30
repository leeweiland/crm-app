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

export function renderBlocksToHtml(blocks, theme) {
  const bg = theme?.background || "#ffffff";
  const maxWidth = theme?.maxWidth || 650;
  const body = renderBlocksInner(blocks);
  return `<div style="background:${bg};padding:24px 0;font-family:Arial,Helvetica,sans-serif"><div style="max-width:${maxWidth}px;margin:0 auto;background:#ffffff">${body}</div></div>`;
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
