import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";

export const INTEGRATIONS_FILE = "crm_integrations.json";

// In-app credential store, admin-only -- lets Lee manage SES/Twilio
// credentials from Settings instead of editing .env on the server directly.
// Values here take priority over process.env so a saved value always wins;
// process.env stays as the zero-config fallback (e.g. Railway env vars) for
// deployments where nobody has touched this UI yet.
function readSettings() {
  return readJson(INTEGRATIONS_FILE, { ses: {}, twilio: {} });
}

export function getSesSettings() {
  const s = readSettings().ses || {};
  return {
    accessKeyId: s.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: s.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "",
    region: s.region || process.env.AWS_REGION || "us-east-2",
    fromAddress: s.fromAddress || process.env.SES_FROM_ADDRESS || "",
    configurationSet: s.configurationSet || process.env.SES_CONFIGURATION_SET || "",
  };
}

export function getTwilioSettings() {
  const t = readSettings().twilio || {};
  return {
    accountSid: t.accountSid || process.env.TWILIO_ACCOUNT_SID || "",
    authToken: t.authToken || process.env.TWILIO_AUTH_TOKEN || "",
    fromNumber: t.fromNumber || process.env.TWILIO_FROM_NUMBER || "",
  };
}

function mask(value) {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return "****" + value.slice(-4);
}

export async function handleIntegrationsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/integrations/")) return false;

  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });
  if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });

  if (p === "/api/integrations/ses" && req.method === "GET") {
    const s = getSesSettings();
    return sendJson(res, 200, {
      configured: !!(s.accessKeyId && s.secretAccessKey && s.fromAddress),
      accessKeyId: mask(s.accessKeyId),
      secretAccessKey: mask(s.secretAccessKey),
      region: s.region, fromAddress: s.fromAddress, configurationSet: s.configurationSet,
    });
  }
  if (p === "/api/integrations/ses" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.ses = all.ses || {};
    // Masked placeholders (e.g. "****AB5P") are never written back over a
    // real stored value -- only overwrite a field when a genuinely new
    // value was typed in.
    for (const k of ["accessKeyId", "secretAccessKey", "region", "fromAddress", "configurationSet"]) {
      if (k in body && !String(body[k]).startsWith("****")) all.ses[k] = body[k];
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/integrations/twilio" && req.method === "GET") {
    const t = getTwilioSettings();
    return sendJson(res, 200, {
      configured: !!(t.accountSid && t.authToken && t.fromNumber),
      accountSid: mask(t.accountSid), authToken: mask(t.authToken), fromNumber: t.fromNumber,
    });
  }
  if (p === "/api/integrations/twilio" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.twilio = all.twilio || {};
    for (const k of ["accountSid", "authToken", "fromNumber"]) {
      if (k in body && !String(body[k]).startsWith("****")) all.twilio[k] = body[k];
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  return false;
}
