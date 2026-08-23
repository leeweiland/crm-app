import { readFileSync, writeFileSync, existsSync, statSync, openSync, writeSync, closeSync, readSync, fstatSync, renameSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same Railway-volume-persistence pattern as chat-app/chat_backend.js:
// without a mounted Volume these files live at __dirname alongside the code
// and reset to whatever's committed in git on every deploy.
export const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;

function migrateDataFile(file) {
  const dest = join(DATA_DIR, file);
  const seed = join(__dirname, file);
  if (dest !== seed && !existsSync(dest) && existsSync(seed)) {
    writeFileSync(dest, readFileSync(seed));
  }
}
export const USERS_FILE = "crm_users.json";
export const SESSIONS_FILE = "crm_sessions.json";
[USERS_FILE, SESSIONS_FILE].forEach(migrateDataFile);

// Opt-in write-behind cache for bulk import scripts, which call readJson/
// writeJson once per record -- fine at small scale, but each call reparses/
// restringifies the WHOLE file, so cost grows with file size and a
// tens-of-thousands-of-records import ends up dominated by repeated I/O on
// the same file. Off by default (live server never sets this env var, so
// its behavior is unchanged); an import script sets IMPORT_BATCH_IO=1 and
// calls flushJsonCache() periodically (e.g. once per page) instead of
// relying on every writeJson to hit disk immediately.
const _batchIo = !!process.env.IMPORT_BATCH_IO;
const _jsonCache = new Map();
const _dirtyFiles = new Set();

// Always-on read cache keyed by mtime, separate from the batch-io path above.
// The live server re-reads+re-parses these files on every single request
// (every inbox/contacts fetch), which dominates response time once a data
// file grows past a few hundred KB. statSync is a metadata-only syscall --
// orders of magnitude cheaper than readFileSync+JSON.parse -- so checking it
// first and only reparsing when mtime actually changed is a safe win for a
// single-process server where every write goes through writeJson below.
const _mtimeCache = new Map(); // file -> { mtimeMs, data }

// Mirrors writeJsonToDisk's reasoning on the read side: JSON.parse(string)
// requires the ENTIRE file to exist as one JS string first, which hits the
// same ~536MB V8 ceiling as JSON.stringify once a data file gets large
// enough -- confirmed live tonight when this silently (before the fix
// above) or would now loudly fail on crm_message_log.json. A Buffer has a
// much higher size ceiling than a string (low GB, not ~536MB), so this
// reads the whole file as a Buffer and scans it BYTE-BY-BYTE (never
// decoding the whole thing to a string) to find each top-level array
// element's boundaries, converting only that one small slice to a string
// for JSON.parse. Byte-level scanning for structural characters ({ } [ ] "
// \ ,) is safe against UTF-8 multi-byte sequences: every continuation byte
// in UTF-8 is >= 0x80, so none of those ASCII structural bytes can ever
// appear as part of a multi-byte character -- no risk of splitting one
// mid-character the way naive chunked string decoding would.
const LARGE_FILE_STREAM_THRESHOLD = 300 * 1024 * 1024; // 300MB
function readJsonArrayStreaming(p) {
  const fd = openSync(p, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      filled += readSync(fd, buf, filled, Math.min(64 * 1024 * 1024, size - filled), filled);
    }
    const results = [];
    let depth = 0, inString = false, escape = false, itemStart = -1;
    let i = 0;
    while (i < size && buf[i] !== 0x5b) i++; // seek opening '['
    itemStart = ++i;
    for (; i < size; i++) {
      const b = buf[i];
      if (inString) {
        if (escape) escape = false;
        else if (b === 0x5c) escape = true; // backslash
        else if (b === 0x22) inString = false; // "
        continue;
      }
      if (b === 0x22) { inString = true; continue; } // "
      if (b === 0x7b || b === 0x5b) { depth++; continue; } // { [
      if (b === 0x7d) { depth--; continue; } // }
      if (b === 0x5d) { // ]
        if (depth === 0) {
          if (i > itemStart) {
            const s = buf.toString("utf8", itemStart, i).trim();
            if (s.length) results.push(JSON.parse(s));
          }
          break;
        }
        depth--;
        continue;
      }
      if (b === 0x2c && depth === 0) { // ,
        const s = buf.toString("utf8", itemStart, i).trim();
        if (s.length) results.push(JSON.parse(s));
        itemStart = i + 1;
      }
    }
    return results;
  } finally { closeSync(fd); }
}
export function readJson(file, fallback) {
  const p = join(DATA_DIR, file);
  if (_batchIo && _jsonCache.has(file)) return _jsonCache.get(file);
  // A missing file is a normal, expected case (first run, not-yet-created
  // data file) -- fall back silently. A file that EXISTS but fails to
  // parse is a completely different situation and must never be treated
  // the same way: confirmed live tonight that silently substituting an
  // empty array for a parse failure (crm_message_log.json outgrew what
  // JSON.parse could handle) let the app carry on as if the file were
  // genuinely empty, and the next write overwrote 900K+ real records with
  // just a few thousand. A parse failure on an existing file must crash
  // loudly instead -- the caller's process dying is vastly preferable to
  // silently destroying data.
  if (!existsSync(p)) { if (_batchIo) _jsonCache.set(file, fallback); return fallback; }
  const stat = statSync(p);
  // Large files are deliberately NOT kept in _mtimeCache on the live
  // server: caching means holding a full parsed copy in memory for as
  // long as the process lives, and this app's data files only grow. The
  // bulk AC import process needs that persistence (IMPORT_BATCH_IO keeps
  // its own separate in-memory copy across thousands of calls in the same
  // run), but the live server re-reading fresh each request lets V8
  // garbage-collect the parsed data after the response is sent instead of
  // accumulating forever. Confirmed live tonight: the live server's own
  // heap hit Node's default ~2GB ceiling and crashed with a genuine OOM
  // while holding cached copies of a 936MB message log.
  if (stat.size >= LARGE_FILE_STREAM_THRESHOLD && !_batchIo) {
    return readJsonArrayStreaming(p);
  }
  const cached = _mtimeCache.get(file);
  let data;
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    data = cached.data;
  } else {
    data = JSON.parse(readFileSync(p, "utf8"));
    _mtimeCache.set(file, { mtimeMs: stat.mtimeMs, data });
  }
  if (_batchIo) _jsonCache.set(file, data);
  return data;
}
// JSON.stringify materializes the ENTIRE result as one JS string before
// writeFileSync ever sees it -- fine at any size that matters for a normal
// app, but crm_message_log.json crossed V8's ~536MB max string length
// tonight and JSON.stringify started throwing RangeError: Invalid string
// length, hard-crashing the process on every write attempt (not just bulk
// imports -- ANY writeJson call on that file, including the live app's
// normal request handlers, would hit the same wall). Writing an array
// element-by-element with separate small writeSync calls never builds one
// giant string, so there's no size ceiling to hit. Non-arrays are rare and
// always small in this app (config-shaped files), so they keep the
// original single-shot pretty-printed write.
//
// Writes to a TEMP file first, then renameSync's it into place. rename()
// on the same filesystem is atomic at the OS level -- readers always see
// either the complete old file or the complete new one, never a partial
// write. This matters a lot more than it used to: writing element-by-
// element (many small writeSync calls) takes measurably longer wall-clock
// time than one big writeFileSync did, which widens the window a
// concurrent reader could catch the file mid-write. Confirmed live tonight:
// the live server hit "SyntaxError: Unexpected end of JSON input" reading
// contacts.json while the bulk import's flush was still writing it.
function writeJsonToDisk(p, data) {
  const tmp = `${p}.tmp${process.pid}`;
  if (!Array.isArray(data)) {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  } else {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, "[");
      data.forEach((item, i) => {
        if (i > 0) writeSync(fd, ",");
        writeSync(fd, JSON.stringify(item));
      });
      writeSync(fd, "]");
    } finally { closeSync(fd); }
  }
  renameSync(tmp, p);
}
export function writeJson(file, data) {
  if (_batchIo) { _jsonCache.set(file, data); _dirtyFiles.add(file); return; }
  const p = join(DATA_DIR, file);
  writeJsonToDisk(p, data);
  try { _mtimeCache.set(file, { mtimeMs: statSync(p).mtimeMs, data }); } catch { _mtimeCache.delete(file); }
}
export function flushJsonCache() {
  for (const file of _dirtyFiles) {
    writeJsonToDisk(join(DATA_DIR, file), _jsonCache.get(file));
  }
  _dirtyFiles.clear();
}

export function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}
export function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
  return true;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(check, "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
export { hashPassword, verifyPassword };

export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, passwordSalt, ...rest } = u;
  return rest;
}

// ── Roles ────────────────────────────────────────────────────────────────
// Three flat roles, no per-permission matrix for v1 — matches the "Admin /
// Super User / User" system roles seen in Close's Roles & Permissions
// screen, simplified to what this internal tool actually needs.
export function isAdmin(user) { return !!user && user.role === "admin"; }
export function isSuperUser(user) { return !!user && (user.role === "superuser" || isAdmin(user)); }

// ── Sessions ─────────────────────────────────────────────────────────────
export function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const match = header.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
function createSession(userId) {
  const sessions = readJson(SESSIONS_FILE, {});
  const token = randomBytes(32).toString("hex");
  sessions[token] = { userId, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 };
  writeJson(SESSIONS_FILE, sessions);
  return token;
}
function destroySession(token) {
  const sessions = readJson(SESSIONS_FILE, {});
  delete sessions[token];
  writeJson(SESSIONS_FILE, sessions);
}
// DEV_SKIP_LOGIN=1 (set in .env) auto-authenticates as the first admin
// user when no valid session exists, so the app is reachable without
// logging in on every local restart. Off unless explicitly set; unset
// the env var (or delete this block) to restore normal login-required
// behavior.
function devAutoUser() {
  if (process.env.DEV_SKIP_LOGIN !== "1") return null;
  const users = readJson(USERS_FILE, []);
  return users.find(u => !u.archived) || null;
}
export function getSessionUser(req) {
  const token = getCookie(req, "crm_session");
  if (!token) return devAutoUser();
  const sessions = readJson(SESSIONS_FILE, {});
  const session = sessions[token];
  if (!session || session.expiresAt < Date.now()) return devAutoUser();
  const users = readJson(USERS_FILE, []);
  const found = users.find(u => u.id === session.userId) || null;
  if (found?.archived) return null;
  return found;
}
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `crm_session=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "crm_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
}

export async function handleAuthRequest(req, res, url) {
  const p = url.pathname;

  // Bootstrap-only signup: this is an internal team tool, not a public
  // signup app like chat-app — there's no ongoing public signup route.
  // The very first account becomes admin; every account after that must be
  // created by an admin via POST /api/auth/users below.
  if (p === "/api/auth/signup" && req.method === "POST") {
    const users = readJson(USERS_FILE, []);
    if (users.length > 0) return sendJson(res, 403, { error: "Signup is closed — ask an admin to create your account" });
    const { email, password, first, last } = await readJsonBody(req);
    if (!email || !password || !first || !last) return sendJson(res, 400, { error: "first, last, email, password are required" });
    if (password.length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters" });
    const { salt, hash } = hashPassword(password);
    const user = {
      id: randomUUID(), email: String(email).toLowerCase(), passwordSalt: salt, passwordHash: hash,
      first, last, role: "admin", archived: false, createdAt: new Date().toISOString(),
    };
    users.push(user);
    writeJson(USERS_FILE, users);
    const token = createSession(user.id);
    setSessionCookie(res, token);
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  }

  if (p === "/api/auth/login" && req.method === "POST") {
    const { email, password } = await readJsonBody(req);
    const users = readJson(USERS_FILE, []);
    const user = users.find(u => u.email === String(email || "").toLowerCase());
    if (!user || user.archived || !verifyPassword(password || "", user.passwordSalt, user.passwordHash)) {
      return sendJson(res, 401, { error: "Invalid email or password" });
    }
    const token = createSession(user.id);
    setSessionCookie(res, token);
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  }

  if (p === "/api/auth/logout" && req.method === "POST") {
    const header = req.headers.cookie || "";
    const match = header.split(";").map(s => s.trim()).find(s => s.startsWith("crm_session="));
    if (match) destroySession(decodeURIComponent(match.slice("crm_session=".length)));
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/auth/me" && req.method === "GET") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (p === "/api/auth/change-password" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const { currentPassword, newPassword } = await readJsonBody(req);
    if (!verifyPassword(currentPassword || "", me.passwordSalt, me.passwordHash)) {
      return sendJson(res, 400, { error: "Current password is incorrect" });
    }
    if (!newPassword || newPassword.length < 8) return sendJson(res, 400, { error: "New password must be at least 8 characters" });
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === me.id);
    const { salt, hash } = hashPassword(newPassword);
    target.passwordSalt = salt;
    target.passwordHash = hash;
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true });
  }

  // ── Admin-only user management ──────────────────────────────────────────
  if (p === "/api/auth/users" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const users = readJson(USERS_FILE, []);
    return sendJson(res, 200, { users: users.map(publicUser) });
  }
  if (p === "/api/auth/users" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const { email, password, first, last, role } = await readJsonBody(req);
    if (!email || !password || !first || !last) return sendJson(res, 400, { error: "first, last, email, password are required" });
    if (!["admin", "superuser", "user"].includes(role)) return sendJson(res, 400, { error: "role must be 'admin', 'superuser', or 'user'" });
    const users = readJson(USERS_FILE, []);
    if (users.some(u => u.email === String(email).toLowerCase())) {
      return sendJson(res, 409, { error: "An account with that email already exists" });
    }
    const { salt, hash } = hashPassword(password);
    const newUser = {
      id: randomUUID(), email: String(email).toLowerCase(), passwordSalt: salt, passwordHash: hash,
      first, last, role, archived: false, createdAt: new Date().toISOString(),
    };
    users.push(newUser);
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true, user: publicUser(newUser) });
  }
  const roleMatch = p.match(/^\/api\/auth\/users\/([^/]+)\/role$/);
  if (roleMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const { role } = await readJsonBody(req);
    if (!["admin", "superuser", "user"].includes(role)) return sendJson(res, 400, { error: "role must be 'admin', 'superuser', or 'user'" });
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === roleMatch[1]);
    if (!target) return sendJson(res, 404, { error: "User not found" });
    if (target.id === me.id && role !== "admin") return sendJson(res, 400, { error: "Can't remove your own admin access" });
    target.role = role;
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }
  const archiveMatch = p.match(/^\/api\/auth\/users\/([^/]+)\/archived$/);
  if (archiveMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const { archived } = await readJsonBody(req);
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === archiveMatch[1]);
    if (!target) return sendJson(res, 404, { error: "User not found" });
    if (target.id === me.id) return sendJson(res, 400, { error: "Can't archive your own account" });
    target.archived = !!archived;
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }

  return false;
}
