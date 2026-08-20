import { readJson } from "./auth_backend.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";
import { AUTOMATIONS_FILE } from "./automations_backend.js";
import { WORKFLOWS_FILE } from "./workflows_backend.js";

function slugify(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
}

// Resolves what a message's outbound "el=" link tag should say, from the
// same sourceType/sourceId every send already carries in the message log --
// so the value always matches whichever campaign/automation/workflow
// actually sent it, with nothing separate to configure or keep in sync.
// sourceType/sourceId shapes match exactly what campaigns_backend.js,
// automations_backend.js, workflows_backend.js, scheduling_backend.js, and
// inbox_backend.js already pass into sendEmail()/sendSms().
export function resolveSendSourceSlug(sourceType, sourceId) {
  if (sourceType === "campaign") {
    const c = readJson(CAMPAIGNS_FILE, []).find(x => x.id === sourceId);
    return c ? slugify(c.name) : "campaign";
  }
  if (sourceType === "automation_step") {
    const automationId = String(sourceId || "").split(":")[0];
    const a = readJson(AUTOMATIONS_FILE, []).find(x => x.id === automationId);
    return a ? slugify(a.name) : "automation";
  }
  if (sourceType === "workflow_step") {
    const workflowId = String(sourceId || "").split(":")[0];
    const w = readJson(WORKFLOWS_FILE, []).find(x => x.id === workflowId);
    return w ? slugify(w.name) : "workflow";
  }
  if (sourceType === "booking") return "booking";
  if (sourceType === "inbox") return "inbox";
  return "manual";
}
