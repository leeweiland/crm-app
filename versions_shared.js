// Lightweight version history, shared by campaigns_backend.js and
// automations_backend.js (each just points it at its own JSON file/entity-id
// key) -- snapshots the pre-change state on save so edits are undoable,
// without needing a real diffing/git-style history system for what's still
// a fairly small internal tool.
import { randomUUID } from "crypto";
import { readJson, writeJson } from "./auth_backend.js";

// Snapshotting on every debounced autosave (every few hundred ms while
// someone's actively typing) would make "history" mostly noise -- once a
// version exists, skip creating another for the same entity until this much
// time has passed, so entries land roughly one per editing session instead
// of one per keystroke pause. A restore always snapshots regardless (see
// `force`), since that's a deliberate action worth its own undo point.
const THROTTLE_MS = 5 * 60 * 1000;
const MAX_VERSIONS_PER_ENTITY = 50;

export function maybeSnapshotVersion(file, entityIdKey, entityId, fields, opts) {
  const versions = readJson(file, []);
  const forEntity = versions.filter(v => v[entityIdKey] === entityId);
  const latest = forEntity[forEntity.length - 1];
  if (!opts?.force && latest && Date.now() - new Date(latest.savedAt).getTime() < THROTTLE_MS) return;

  versions.push({ id: randomUUID(), [entityIdKey]: entityId, snapshot: fields, savedAt: new Date().toISOString() });

  const nowForEntity = versions.filter(v => v[entityIdKey] === entityId);
  if (nowForEntity.length > MAX_VERSIONS_PER_ENTITY) {
    const dropIds = new Set(nowForEntity.slice(0, nowForEntity.length - MAX_VERSIONS_PER_ENTITY).map(v => v.id));
    writeJson(file, versions.filter(v => !dropIds.has(v.id)));
  } else {
    writeJson(file, versions);
  }
}

export function listVersions(file, entityIdKey, entityId) {
  return readJson(file, [])
    .filter(v => v[entityIdKey] === entityId)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

export function getVersion(file, entityIdKey, entityId, versionId) {
  return readJson(file, []).find(v => v[entityIdKey] === entityId && v.id === versionId) || null;
}
