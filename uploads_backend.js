import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonBody, sendJson, getSessionUser, DATA_DIR } from "./auth_backend.js";

const UPLOADS_DIR = join(DATA_DIR, "uploads");
const MIME_TO_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

export async function handleUploadsRequest(req, res, url) {
  const p = url.pathname;

  // Public: serving the uploaded file itself needs no session (it's
  // embedded in emails opened by recipients, not just the CRM UI).
  const fileMatch = p.match(/^\/uploads\/([a-zA-Z0-9_-]+\.[a-z]+)$/);
  if (fileMatch && req.method === "GET") {
    const filePath = join(UPLOADS_DIR, fileMatch[1]);
    if (!existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return true; }
    const ext = fileMatch[1].split(".").pop();
    const mime = Object.entries(MIME_TO_EXT).find(([, e]) => e === ext)?.[0] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
    res.end(readFileSync(filePath));
    return true;
  }

  if (p !== "/api/uploads/image" || req.method !== "POST") return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  const { dataUrl } = await readJsonBody(req);
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) return sendJson(res, 400, { error: "Expected a base64 image data URL" });
  const [, mimeType, base64] = match;
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) return sendJson(res, 400, { error: "Unsupported image type: " + mimeType });

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > 8 * 1024 * 1024) return sendJson(res, 400, { error: "Image too large (max 8MB)" });

  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  writeFileSync(join(UPLOADS_DIR, filename), buffer);

  return sendJson(res, 200, { ok: true, url: `/uploads/${filename}` });
}
