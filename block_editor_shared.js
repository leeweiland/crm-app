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
  const bg = theme?.background || "#f4f4f4";
  const maxWidth = theme?.maxWidth || 650;
  const body = (blocks || []).map(renderBlock).join("");
  return `<div style="background:${bg};padding:24px 0;font-family:Arial,Helvetica,sans-serif"><div style="max-width:${maxWidth}px;margin:0 auto;background:#ffffff">${body}</div></div>`;
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

// Rewrites every <a href="..."> to a click-tracking redirect through
// /api/email/click, so open/click reporting (#8 in the plan) can attribute
// a click back to this specific send. The original destination is
// preserved as a query param and the redirect handler 302s to it after
// logging the click.
export function rewriteLinksForTracking(html, { messageLogId, baseUrl }) {
  return String(html || "").replace(/href="([^"]+)"/g, (match, url) => {
    if (url.startsWith("mailto:") || url.startsWith("#")) return match;
    const tracked = `${baseUrl}/api/email/click?m=${encodeURIComponent(messageLogId)}&u=${encodeURIComponent(url)}`;
    return `href="${tracked}"`;
  });
}
