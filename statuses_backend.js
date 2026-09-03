import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";

export const STATUSES_FILE = "crm_statuses.json";

// Seeded from Lee's actual Close "Lead Statuses" list, in real pipeline
// order (POTENTIAL lowest, FINISHED highest) so day-one contacts have a
// familiar, ready-to-use status vocabulary instead of an empty list. This
// order is a real hierarchy, not just display order -- see
// segments_shared.js's applyAdvancingStatus, which every automated status
// change (a form's booking step, a new booking) goes through so it can
// never move a contact backward.
const SEED_STATUSES = [
  "POTENTIAL", "FOLLOW UP (They have a Task / Date set)", "APPLICATION",
  "BOOKED", "WE CANCELLED", "RSVP'ed", "ENROLLED", "STOP", "BLACKLIST", "FINISHED",
].map((label, i) => ({ id: randomUUID(), label, order: i, color: "#5f727f", isTerminal: false, createdAt: new Date().toISOString() }));

function getStatuses() {
  const statuses = readJson(STATUSES_FILE, null);
  if (statuses) return statuses;
  writeJson(STATUSES_FILE, SEED_STATUSES);
  return SEED_STATUSES;
}

export async function handleStatusesRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/statuses")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/statuses" && req.method === "GET") {
    const statuses = getStatuses().slice().sort((a, b) => a.order - b.order);
    return sendJson(res, 200, { statuses });
  }
  if (p === "/api/statuses" && req.method === "POST") {
    const { label, color } = await readJsonBody(req);
    if (!label) return sendJson(res, 400, { error: "label is required" });
    const statuses = getStatuses();
    const status = { id: randomUUID(), label, order: statuses.length, color: color || "#5f727f", isTerminal: false, createdAt: new Date().toISOString() };
    statuses.push(status);
    writeJson(STATUSES_FILE, statuses);
    return sendJson(res, 200, { ok: true, status });
  }
  if (p === "/api/statuses/reorder" && req.method === "POST") {
    const { orderedIds } = await readJsonBody(req);
    if (!Array.isArray(orderedIds)) return sendJson(res, 400, { error: "orderedIds must be an array" });
    const statuses = getStatuses();
    orderedIds.forEach((id, i) => {
      const s = statuses.find(x => x.id === id);
      if (s) s.order = i;
    });
    writeJson(STATUSES_FILE, statuses);
    return sendJson(res, 200, { ok: true });
  }
  const statusMatch = p.match(/^\/api\/statuses\/([^/]+)$/);
  if (statusMatch) {
    const statuses = getStatuses();
    const status = statuses.find(s => s.id === statusMatch[1]);
    if (req.method === "PATCH") {
      if (!status) return sendJson(res, 404, { error: "Status not found" });
      const body = await readJsonBody(req);
      if ("label" in body) status.label = body.label;
      if ("color" in body) status.color = body.color;
      if ("isTerminal" in body) status.isTerminal = !!body.isTerminal;
      writeJson(STATUSES_FILE, statuses);
      return sendJson(res, 200, { ok: true, status });
    }
    if (req.method === "DELETE") {
      writeJson(STATUSES_FILE, statuses.filter(s => s.id !== statusMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  return false;
}
