import { randomUUID, randomBytes } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { fireTrigger } from "./automations_backend.js";
import { fireWorkflowTrigger } from "./workflows_backend.js";

export const WEBHOOK_CONFIGS_FILE = "crm_webhook_configs.json";

function readRawBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => resolve(body));
  });
}

export async function handleWebhooksRequest(req, res, url) {
  const p = url.pathname;

  // ── Public: no Zapier in the middle -- point a Framer Form's "Send to a
  // URL" action straight at this, one URL per form (the random token in
  // the path). Accepts either JSON or form-encoded bodies since Framer's
  // native form action and a custom code-override fetch() can send either. ─
  const framerMatch = p.match(/^\/api\/webhooks\/framer\/([^/]+)$/);
  if (framerMatch && req.method === "POST") {
    const configs = readJson(WEBHOOK_CONFIGS_FILE, []);
    const config = configs.find(c => c.webhookToken === framerMatch[1]);
    if (!config) { res.writeHead(404); res.end("Unknown form"); return true; }

    const contentType = req.headers["content-type"] || "";
    let fields = {};
    if (contentType.includes("application/json")) {
      fields = await readJsonBody(req);
    } else {
      const raw = await readRawBody(req);
      fields = Object.fromEntries(new URLSearchParams(raw));
    }

    // fieldMap: { "<Framer field label>": "first"|"last"|"email"|"phone"|"customField:<id>" }
    const mapped = { first: "", last: "", email: "", phone: "", customFields: {} };
    for (const [framerLabel, target] of Object.entries(config.fieldMap || {})) {
      const value = fields[framerLabel];
      if (value === undefined || value === null) continue;
      if (target.startsWith("customField:")) mapped.customFields[target.slice("customField:".length)] = value;
      else mapped[target] = value;
    }

    const contacts = readJson(CONTACTS_FILE, []);
    let contact = mapped.email ? contacts.find(c => c.email && c.email.toLowerCase() === mapped.email.toLowerCase()) : null;
    let isNew = false;
    if (contact) {
      contact.first = mapped.first || contact.first;
      contact.last = mapped.last || contact.last;
      contact.phone = mapped.phone || contact.phone;
      contact.customFields = { ...contact.customFields, ...mapped.customFields };
      contact.updatedAt = new Date().toISOString();
    } else {
      isNew = true;
      contact = {
        id: randomUUID(), type: "contact", accountName: "",
        first: mapped.first || "", last: mapped.last || "", email: (mapped.email || "").toLowerCase(), phone: mapped.phone || "",
        status: config.defaultStatusId || "", tags: [...(config.defaultTagIds || [])], listIds: [...(config.defaultListIds || [])],
        customFields: mapped.customFields, source: `framer:${config.id}`, ownerId: null,
        emailOptOut: false, smsOptOut: false, externalIds: { acContactId: null, closeLeadId: null },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      contacts.push(contact);
    }
    writeJson(CONTACTS_FILE, contacts);

    // Only fire triggers for a genuinely new contact -- an EXISTING
    // contact resubmitting the same form shouldn't re-enroll them in
    // whatever the default list/tags trigger.
    if (isNew) {
      contact.listIds.forEach(listId => { fireTrigger("list_subscribe", { contactId: contact.id, listId }); fireWorkflowTrigger("list_subscribe", { contactId: contact.id, listId }); });
      contact.tags.forEach(tagId => { fireTrigger("tag_added", { contactId: contact.id, tagId }); fireWorkflowTrigger("tag_added", { contactId: contact.id, tagId }); });
    }

    return sendJson(res, 200, { ok: true });
  }

  // ── Admin: manage the field-mapping configs themselves ────────────────
  const owned = p.startsWith("/api/webhook-configs");
  if (!owned) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/webhook-configs" && req.method === "GET") {
    return sendJson(res, 200, { configs: readJson(WEBHOOK_CONFIGS_FILE, []) });
  }
  if (p === "/api/webhook-configs" && req.method === "POST") {
    const { name } = await readJsonBody(req);
    const configs = readJson(WEBHOOK_CONFIGS_FILE, []);
    const config = {
      id: randomUUID(), name: name || "Untitled Form",
      webhookToken: randomBytes(12).toString("hex"),
      fieldMap: {}, defaultListIds: [], defaultTagIds: [], defaultStatusId: null,
      createdAt: new Date().toISOString(),
    };
    configs.push(config);
    writeJson(WEBHOOK_CONFIGS_FILE, configs);
    return sendJson(res, 200, { ok: true, config });
  }
  const configMatch = p.match(/^\/api\/webhook-configs\/([^/]+)$/);
  if (configMatch) {
    const configs = readJson(WEBHOOK_CONFIGS_FILE, []);
    const config = configs.find(c => c.id === configMatch[1]);
    if (req.method === "PATCH") {
      if (!config) return sendJson(res, 404, { error: "Not found" });
      const body = await readJsonBody(req);
      for (const k of ["name", "fieldMap", "defaultListIds", "defaultTagIds", "defaultStatusId"]) if (k in body) config[k] = body[k];
      writeJson(WEBHOOK_CONFIGS_FILE, configs);
      return sendJson(res, 200, { ok: true, config });
    }
    if (req.method === "DELETE") {
      writeJson(WEBHOOK_CONFIGS_FILE, configs.filter(c => c.id !== configMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  return false;
}
