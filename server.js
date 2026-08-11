import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { handleAuthRequest } from "./auth_backend.js";
import { handleContactsRequest } from "./contacts_backend.js";
import { handleStatusesRequest } from "./statuses_backend.js";
import { handleEmailRequest } from "./email_backend.js";
import { handleCampaignsRequest } from "./campaigns_backend.js";
import { handleAutomationsRequest } from "./automations_backend.js";
import { handleReportingRequest } from "./reporting_backend.js";
import { startScheduler } from "./scheduler.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3457;

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack ?? err);
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Feature modules each own their own /api/* route group and return true
  // once they've handled a request — server.js is just the dispatch chain
  // plus the static-file fallback below. Adding a feature (Phase 2+) means
  // adding one more line here, nothing else changes.
  if (await handleAuthRequest(req, res, url)) return;
  if (await handleContactsRequest(req, res, url)) return;
  if (await handleStatusesRequest(req, res, url)) return;
  if (await handleEmailRequest(req, res, url)) return;
  if (await handleCampaignsRequest(req, res, url)) return;
  if (await handleAutomationsRequest(req, res, url)) return;
  if (await handleReportingRequest(req, res, url)) return;

  // Static file serving — this app is its own Railway service (unlike
  // chat-app, which shares a domain/nav with sibling apps), so there's no
  // URL prefix to strip.
  let pathname = url.pathname;
  let filePath = join(__dirname, pathname === "/" ? "login.html" : pathname);
  if (!existsSync(filePath)) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const ext = extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  const noCacheExts = [".html", ".js", ".css"];
  if (noCacheExts.includes(ext)) res.setHeader("Cache-Control", "no-store");
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(filePath));
}).listen(PORT, () => console.log(`crm-app running on port ${PORT}`));

startScheduler();
