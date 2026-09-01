import { readFileSync, writeFileSync, existsSync, statSync, openSync, writeSync, closeSync, readSync, fstatSync, renameSync, unlinkSync, ftruncateSync } from "fs";
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
// Declared locally (matching segments_shared.js's own reasoning) rather than
// imported from email_backend.js, which already imports from this file --
// that import would be circular.
const FOOTER_TEMPLATES_FILE = "crm_footer_templates.json";

// Every new user (any role) gets their own blank footer template up front,
// named after them and pre-linked via footerTemplateId, so their 1:1 Inbox
// replies never default to someone else's signature/photo just because
// nobody remembered to set one up. Content stays empty until they (or an
// admin) fill it in via the same footer editor everything else uses.
function createFooterForUser(first, last) {
  const templates = readJson(FOOTER_TEMPLATES_FILE, []);
  const template = {
    id: randomUUID(), name: `${first} ${last} Footer`, blocks: [], theme: {},
    unsubscribeLinkText: "Unsubscribe", physicalAddress: "", socialLinks: [],
    isDefault: templates.length === 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  templates.push(template);
  writeJson(FOOTER_TEMPLATES_FILE, templates);
  return template.id;
}

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

// Calls onElement(rawJsonSubstring) once per top-level array element,
// reading the file in fixed-size chunks instead of one Buffer.alloc(whole
// file). Confirmed live tonight: crm_message_log.json reached 4.92GB, and
// allocating a single Buffer that size (on top of whatever else is
// resident) is itself now a real crash risk -- for the bulk import script
// AND for the live server, since every readJson(MESSAGE_LOG_FILE) call on
// the live server (inbox, reporting, compliance, etc) goes through this
// same large-file path. Bounding the read to a fixed chunk size (plus
// whatever partial element carries over a chunk boundary, normally tiny)
// keeps this read's own memory footprint constant regardless of file size.
// Byte-level scanning for structural characters ({ } [ ] " \ ,) is safe
// against UTF-8 multi-byte sequences: every continuation byte in UTF-8 is
// >= 0x80, so none of those ASCII structural bytes can ever appear as part
// of a multi-byte character -- no risk of splitting one mid-character, and
// no risk of splitting one across a chunk boundary either, since the same
// per-byte state machine (inString/escape/depth) carries across chunks.
function forEachJsonArrayElement(p, onElement) {
  const fd = openSync(p, "r");
  try {
    const size = fstatSync(fd).size;
    const CHUNK = 64 * 1024 * 1024;
    const readBuf = Buffer.alloc(Math.min(CHUNK, size || 1));
    let depth = 0, inString = false, escape = false, seenOpenBracket = false;
    let carry = Buffer.alloc(0);
    let bytesReadTotal = 0, finished = false;
    while (bytesReadTotal < size && !finished) {
      const toRead = Math.min(readBuf.length, size - bytesReadTotal);
      const n = readSync(fd, readBuf, 0, toRead, bytesReadTotal);
      bytesReadTotal += n;
      const carryLen = carry.length;
      const buf = carryLen ? Buffer.concat([carry, readBuf.subarray(0, n)]) : Buffer.from(readBuf.subarray(0, n));
      carry = Buffer.alloc(0);
      const len = buf.length;
      let i, itemStart;
      if (!seenOpenBracket) {
        i = 0;
        while (i < len && buf[i] !== 0x5b) i++; // seek opening '['
        if (i >= len) { carry = buf; continue; } // '[' not in this chunk yet -- keep buffering
        seenOpenBracket = true;
        itemStart = ++i;
      } else {
        // itemStart=0 so the eventual element slice still includes the
        // carried-over bytes, but the scan cursor resumes at carryLen --
        // those bytes already passed through the depth/inString/escape
        // state machine at the end of the PREVIOUS chunk (that's how they
        // ended up as carry in the first place). Re-scanning them here
        // would double-count every brace/bracket in a record that has any
        // nested structure (statusHistory arrays, hyrosSaleData objects),
        // corrupting depth until it hits 0 at the wrong byte and the whole
        // scan thinks the array ended early. Confirmed live: real message
        // log records (unlike this file's own small test fixtures) have
        // exactly this nesting, and the double-scan bug made a 4.92GB scan
        // stop after just 134MB, returning 0 matches instead of millions.
        itemStart = 0;
        i = carryLen;
      }
      for (; i < len; i++) {
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
            if (i > itemStart) emitElement(buf, itemStart, i, onElement);
            finished = true;
            break;
          }
          depth--;
          continue;
        }
        if (b === 0x2c && depth === 0) { // ,
          emitElement(buf, itemStart, i, onElement);
          itemStart = i + 1;
        }
      }
      if (!finished && itemStart < len) carry = Buffer.from(buf.subarray(itemStart, len));
    }
  } finally { closeSync(fd); }
}
// Trims leading/trailing ASCII whitespace by index arithmetic only -- no
// string materialized here, so a caller that only needs to search for a
// small substring within the element (scanJsonArrayFieldSets below) never
// pays for converting the whole record (which can carry a multi-KB email
// body/subject) to a JS string just to throw it away a moment later.
function emitElement(buf, start, end, onElement) {
  while (start < end && (buf[start] === 0x20 || buf[start] === 0x0a || buf[start] === 0x0d || buf[start] === 0x09)) start++;
  while (end > start && (buf[end - 1] === 0x20 || buf[end - 1] === 0x0a || buf[end - 1] === 0x0d || buf[end - 1] === 0x09)) end--;
  if (end > start) onElement(buf, start, end);
}
function readJsonArrayStreaming(p) {
  const results = [];
  forEachJsonArrayElement(p, (buf, start, end) => { results.push(JSON.parse(buf.toString("utf8", start, end))); });
  return results;
}

// Reads a JSON array file and returns only the elements matching predicate,
// WITHOUT ever holding the full unfiltered array in memory first. Confirmed
// live: several inbox endpoints did readJson(MESSAGE_LOG_FILE, []).filter(...)
// -- once the message log passed several GB (millions of records, most
// carrying full email bodies/statusHistory/hyrosSaleData), materializing
// the ENTIRE array just to filter down to one contact's few dozen messages
// crashed the live server with a real OOM, repeatedly, for every affected
// page load. Below the streaming threshold this is just readJson+filter
// (no reason to pay chunk-scanning overhead on a small file); above it,
// streams via forEachJsonArrayElement and only ever parses+keeps elements
// that already pass the predicate.
export function readJsonArrayFiltered(file, predicate) {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) return [];
  const stat = statSync(p);
  if (stat.size < LARGE_FILE_STREAM_THRESHOLD) {
    return readJson(file, []).filter(predicate);
  }
  const results = [];
  forEachJsonArrayElement(p, (buf, start, end) => {
    let obj;
    try { obj = JSON.parse(buf.toString("utf8", start, end)); } catch { return; }
    if (predicate(obj)) results.push(obj);
  });
  return results;
}

// Streams a JSON array file element-by-element, folding each one into an
// accumulator via reducer(acc, element) -- for building a bounded-size
// SUMMARY from an unbounded-size log (e.g. "latest message per contact")
// without ever holding more than one element and the (much smaller)
// accumulator in memory at once. Companion to readJsonArrayFiltered above:
// that one still costs O(matching records) memory, which is fine for "one
// contact's messages" but not for "one summary row per contact, computed
// from millions of messages across all contacts" -- this is the one to use
// for that shape of query instead.
export function reduceJsonArray(file, reducer, initial) {
  const p = join(DATA_DIR, file);
  let acc = initial;
  if (!existsSync(p)) return acc;
  const stat = statSync(p);
  if (stat.size < LARGE_FILE_STREAM_THRESHOLD) {
    for (const el of readJson(file, [])) acc = reducer(acc, el);
    return acc;
  }
  forEachJsonArrayElement(p, (buf, start, end) => {
    let obj;
    try { obj = JSON.parse(buf.toString("utf8", start, end)); } catch { return; }
    acc = reducer(acc, obj);
  });
  return acc;
}

// Streams a JSON array file and keeps only the top K matching elements by
// compareFn (higher compareFn(a,b) means a ranks better/first), with
// memory bounded to O(k) regardless of how many elements match the
// predicate. readJsonArrayFiltered isn't enough on its own when the
// predicate itself isn't selective -- confirmed live: filtering the
// message log down to "direction === inbound" still matched millions of
// records (most of tonight's Hyros/AC/Close import history genuinely has
// that direction), and materializing THAT still crashed the server with a
// real OOM, even though the scan itself was bounded. `top` stays sorted
// best-to-worst (descending by compareFn) and is maintained via binary
// search + splice rather than a full re-sort per insertion -- the common
// case (a candidate worse than the current worst-of-the-best) is rejected
// in O(1) via a single comparison before ever touching the array, so the
// expensive O(k) splice only happens for the minority of candidates that
// actually make the cut.
function insertTopK(top, obj, k, compareFn) {
  if (top.length >= k && compareFn(obj, top[top.length - 1]) <= 0) return;
  let lo = 0, hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareFn(top[mid], obj) < 0) hi = mid; else lo = mid + 1;
  }
  top.splice(lo, 0, obj);
  if (top.length > k) top.length = k;
}
export function topKJsonArray(file, predicate, k, compareFn) {
  const p = join(DATA_DIR, file);
  const top = [];
  if (!existsSync(p)) return top;
  const stat = statSync(p);
  if (stat.size < LARGE_FILE_STREAM_THRESHOLD) {
    for (const el of readJson(file, [])) if (predicate(el)) insertTopK(top, el, k, compareFn);
    return top;
  }
  forEachJsonArrayElement(p, (buf, start, end) => {
    let obj;
    try { obj = JSON.parse(buf.toString("utf8", start, end)); } catch { return; }
    if (predicate(obj)) insertTopK(top, obj, k, compareFn);
  });
  return top;
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
  // Large files always go through the streaming reader, regardless of
  // batch-IO mode -- JSON.parse(readFileSync()) throws ERR_STRING_TOO_LONG
  // past V8's ~512MB string ceiling no matter who's calling it. Confirmed
  // live tonight: the bulk AC import (which runs with IMPORT_BATCH_IO=1)
  // crashed on its very first read of the 936MB message log, because this
  // check used to be gated on `!_batchIo` and skipped straight to
  // JSON.parse. Batch mode still gets its persistence: the streamed
  // result is cached in _jsonCache below just like the non-streamed path,
  // so this only costs one streaming read per file per run, not per call.
  //
  // Large files are deliberately NOT kept in _mtimeCache on the live
  // server: caching means holding a full parsed copy in memory for as
  // long as the process lives, and this app's data files only grow. The
  // live server re-reading fresh each request lets V8 garbage-collect the
  // parsed data after the response is sent instead of accumulating
  // forever. Confirmed live tonight: the live server's own heap hit
  // Node's default ~2GB ceiling and crashed with a genuine OOM while
  // holding cached copies of a 936MB message log.
  if (stat.size >= LARGE_FILE_STREAM_THRESHOLD) {
    const data = readJsonArrayStreaming(p);
    if (_batchIo) _jsonCache.set(file, data);
    return data;
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

// Scans a large JSON array file for specific string field values WITHOUT
// ever building a JS object per element. Confirmed live tonight: the AC
// bulk import's dedup-index step used readJson (full JSON.parse of every
// element) just to pull out two id fields per record, and once the message
// log passed ~4 million records the resulting array of full parsed objects
// -- each carrying subject/body text, statusHistory arrays, nested sale
// data, etc -- blew past a 3GB heap ceiling. A raw file Buffer is EXTERNAL
// memory (outside V8's heap accounting entirely), and per-element strings
// here are thrown away immediately after their regex match, so the only
// heap cost is the output Sets of short id strings -- orders of magnitude
// less than materializing the whole log. Reuses the same byte-level
// array-boundary scan as readJsonArrayStreaming; see its comment for why
// scanning structural bytes is UTF-8-safe.
export function scanJsonArrayFieldSets(file, fieldNames) {
  const result = {};
  fieldNames.forEach(f => { result[f] = new Set(); });
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) return result;
  // Searches raw buffer bytes for each field's `"field":"` key pattern
  // instead of materializing the whole record as a string first. Confirmed
  // live: with ~9M records (most of them matching one of these two
  // fields), converting every record to a full string just to run a regex
  // -- including subject/body/statusHistory/hyrosSaleData content that has
  // nothing to do with the match -- generated enough garbage to need 7GB+
  // of heap even though the actual retained Sets are under 1GB. Only the
  // short matched VALUE gets turned into a string now. Values here are
  // this app's own generated ids (ac_send:<n>, ac_camp:<n>) with no
  // embedded quotes or backslashes, so a plain unescaped-quote scan for
  // the closing delimiter is safe -- not a general-purpose JSON string
  // parser.
  const needles = fieldNames.map(f => ({ field: f, needle: Buffer.from(`"${f}":"`) }));
  forEachJsonArrayElement(p, (buf, start, end) => {
    // buf.indexOf has no "stop searching at this offset" parameter -- it
    // scans forward from `start` to the end of the WHOLE underlying chunk
    // buffer (up to 64MB) looking for the needle, ignoring `end` entirely.
    // Confirmed live: for any element that doesn't contain a given field
    // (e.g. a hyros record has neither acActivityId nor acCampaignId, and
    // even most ac_import records only carry ONE of the two), that turned
    // into a multi-megabyte scan per miss instead of a check bounded to
    // this one small record -- the scan that finished in 58s with a
    // regex-per-full-string approach was still running after 10+ minutes
    // with this "optimization" before being killed. `.subarray(start,
    // end)` is a VIEW (no copy), so bounding the search to it costs
    // nothing extra while guaranteeing indexOf never looks past this
    // element's own bytes.
    const view = buf.subarray(start, end);
    for (const { field, needle } of needles) {
      const idx = view.indexOf(needle);
      if (idx === -1) continue;
      const valueStart = idx + needle.length;
      let valueEnd = valueStart;
      while (valueEnd < view.length && view[valueEnd] !== 0x22) valueEnd++;
      result[field].add(view.toString("utf8", valueStart, valueEnd));
    }
  });
  return result;
}

// Appends records onto a JSON array file WITHOUT ever reading/parsing the
// existing contents into JS objects -- companion fix to
// scanJsonArrayFieldSets above, for the same reason: at 4M+ records the
// message log's parsed form is far too big to hold in memory just to push a
// few hundred new entries onto it. Copies the file byte-for-byte (fixed-size
// buffer, O(1) memory regardless of file size) up to its closing ']', then
// appends the new records and closes the array, writing to a temp file and
// renaming into place same as writeJsonToDisk -- a concurrent reader always
// sees either the complete old file or the complete new one.
// True O(new data) append -- truncates off the closing ']' and writes the
// new record(s) plus a fresh ']' at that exact byte offset, in place,
// instead of copying the file. appendJsonRecords (below) copies every
// existing byte to a temp file first for atomicity, which is fine for bulk
// imports (one call flushes thousands of records, amortizing that cost) but
// was fatal for message_log.js's per-message logMessage: confirmed live,
// every single email/SMS send was copying the ENTIRE 12GB+ message log just
// to add one row, hanging the send for 30-100+ seconds. There IS a real
// (tiny) crash-safety tradeoff versus the copy+rename approach: a crash
// between the truncate and the write would leave the file missing its
// closing ']' until the next append recovers it -- accepted deliberately
// here because the alternative (blocking every live send on a multi-GB
// copy) is far worse in practice, and both truncate+write are synchronous
// with nothing else able to run in between on this single-threaded process.
export function appendJsonRecordFast(file, record) {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) { writeJsonToDisk(p, [record]); return; }
  const fd = openSync(p, "r+");
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 64);
    const tailBuf = Buffer.alloc(tailLen);
    readSync(fd, tailBuf, 0, tailLen, size - tailLen);
    let end = tailLen - 1;
    while (end >= 0 && (tailBuf[end] === 0x20 || tailBuf[end] === 0x0a || tailBuf[end] === 0x0d || tailBuf[end] === 0x09)) end--;
    if (end < 0 || tailBuf[end] !== 0x5d) throw new Error(`appendJsonRecordFast: ${file} does not end with ']'`);
    const bodyEnd = size - (tailLen - end);

    const headLen = Math.min(size, 256);
    const headBuf = Buffer.alloc(headLen);
    readSync(fd, headBuf, 0, headLen, 0);
    let hi = 0;
    while (hi < headLen && headBuf[hi] !== 0x5b) hi++;
    hi++;
    while (hi < headLen && (headBuf[hi] === 0x20 || headBuf[hi] === 0x0a || headBuf[hi] === 0x0d || headBuf[hi] === 0x09)) hi++;
    const isEmpty = hi < headLen && headBuf[hi] === 0x5d;

    const suffix = Buffer.from((isEmpty ? "" : ",") + JSON.stringify(record) + "]", "utf8");
    ftruncateSync(fd, bodyEnd);
    writeSync(fd, suffix, 0, suffix.length, bodyEnd);
  } finally { closeSync(fd); }
  _mtimeCache.delete(file);
}

// Same in-place trick as appendJsonRecordFast, for a JSON OBJECT (keyed
// lookup) instead of an array -- used for small persisted indexes like
// providerMessageId -> {id, contactId}, where a webhook needs to find one
// row by an external id in O(1) instead of scanning the whole message log.
export function appendToJsonObjectFast(file, key, value) {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) { writeJsonToDisk(p, { [key]: value }); return; }
  const fd = openSync(p, "r+");
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 64);
    const tailBuf = Buffer.alloc(tailLen);
    readSync(fd, tailBuf, 0, tailLen, size - tailLen);
    let end = tailLen - 1;
    while (end >= 0 && (tailBuf[end] === 0x20 || tailBuf[end] === 0x0a || tailBuf[end] === 0x0d || tailBuf[end] === 0x09)) end--;
    if (end < 0 || tailBuf[end] !== 0x7d) throw new Error(`appendToJsonObjectFast: ${file} does not end with '}'`);
    const bodyEnd = size - (tailLen - end);

    const headLen = Math.min(size, 256);
    const headBuf = Buffer.alloc(headLen);
    readSync(fd, headBuf, 0, headLen, 0);
    let hi = 0;
    while (hi < headLen && headBuf[hi] !== 0x7b) hi++;
    hi++;
    while (hi < headLen && (headBuf[hi] === 0x20 || headBuf[hi] === 0x0a || headBuf[hi] === 0x0d || headBuf[hi] === 0x09)) hi++;
    const isEmpty = hi < headLen && headBuf[hi] === 0x7d;

    const suffix = Buffer.from((isEmpty ? "" : ",") + JSON.stringify(key) + ":" + JSON.stringify(value) + "}", "utf8");
    ftruncateSync(fd, bodyEnd);
    writeSync(fd, suffix, 0, suffix.length, bodyEnd);
  } finally { closeSync(fd); }
  _mtimeCache.delete(file);
}

export function appendJsonRecords(file, newRecords) {
  if (!newRecords || !newRecords.length) return;
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) { writeJsonToDisk(p, newRecords); return; }
  const tmp = `${p}.tmp${process.pid}`;
  const srcFd = openSync(p, "r");
  let bodyEnd, isEmpty;
  try {
    const size = fstatSync(srcFd).size;
    const tailLen = Math.min(size, 64);
    const tailBuf = Buffer.alloc(tailLen);
    readSync(srcFd, tailBuf, 0, tailLen, size - tailLen);
    let end = tailLen - 1;
    while (end >= 0 && (tailBuf[end] === 0x20 || tailBuf[end] === 0x0a || tailBuf[end] === 0x0d || tailBuf[end] === 0x09)) end--;
    if (end < 0 || tailBuf[end] !== 0x5d) throw new Error(`appendJsonRecords: ${file} does not end with ']'`);
    bodyEnd = size - (tailLen - end);

    const headLen = Math.min(size, 256);
    const headBuf = Buffer.alloc(headLen);
    readSync(srcFd, headBuf, 0, headLen, 0);
    let hi = 0;
    while (hi < headLen && headBuf[hi] !== 0x5b) hi++;
    hi++;
    while (hi < headLen && (headBuf[hi] === 0x20 || headBuf[hi] === 0x0a || headBuf[hi] === 0x0d || headBuf[hi] === 0x09)) hi++;
    isEmpty = hi < headLen && headBuf[hi] === 0x5d;

    // Windows (unlike POSIX/Linux) refuses to rename a file over a
    // destination that still has an open handle pointing at it -- confirmed
    // testing locally: renameSync threw EPERM until srcFd was closed first.
    // Not an issue on Railway's Linux containers, but closing before the
    // rename is correct and safe on both, so do it unconditionally.
    const dstFd = openSync(tmp, "w");
    try {
      const CHUNK = 64 * 1024 * 1024;
      const copyBuf = Buffer.alloc(Math.min(CHUNK, bodyEnd || 1));
      let copied = 0;
      while (copied < bodyEnd) {
        const n = readSync(srcFd, copyBuf, 0, Math.min(copyBuf.length, bodyEnd - copied), copied);
        writeSync(dstFd, copyBuf, 0, n);
        copied += n;
      }
      newRecords.forEach((r, i) => {
        if (!isEmpty || i > 0) writeSync(dstFd, ",");
        writeSync(dstFd, JSON.stringify(r));
      });
      writeSync(dstFd, "]");
    } finally { closeSync(dstFd); }
  } finally { closeSync(srcFd); }
  renameSync(tmp, p);
  // This writes via raw fs calls, not writeJson, so it never refreshes
  // _mtimeCache the way writeJson does -- and confirmed live in testing,
  // two writes to the same file close enough together can land on the
  // SAME mtimeMs (this filesystem/Node combo doesn't always give
  // sub-millisecond resolution), which would make readJson's "has mtime
  // changed?" check wrongly say no and keep serving the pre-append data
  // forever. Deleting the entry instead of trying to refresh it is the
  // safe option -- the next readJson call just does one real reparse.
  _mtimeCache.delete(file);
}

// Finds the array element whose `field` property equals `value` and applies
// updater(el) to it, rewriting the file with only that one element changed --
// every other element is copied byte-for-byte, never parsed, same
// don't-touch-what-didn't-match philosophy as scanJsonArrayFieldSets above.
// Companion to appendJsonRecords for the opposite direction: message_log.js's
// per-message updates (delivery/open/click webhooks, manual edits) were doing
// readJson+writeJson against the whole message log to change ONE record --
// both an OOM risk and needlessly slow at millions of records. Still O(file
// size) TIME since every byte has to pass through one way or another; this
// buys crash-safety and avoids paying to stringify records that didn't
// change, not "instant" updates -- a genuinely fast single-record update
// needs a real index, not a full-file rewrite.
export function updateJsonArrayRecordByField(file, field, value, updater) {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) return null;
  // Two needles, not one -- a file that's only ever been through
  // appendJsonRecordFast/this same function stays compact ("field":"value",
  // no space), but one written even once via writeJson's JSON.stringify(d,
  // null, 2) is pretty-printed ("field": "value", WITH a space). Matching
  // only the compact form meant this silently returned "not found" against
  // any file in the latter state -- confirmed live against crm_contacts.json,
  // which is always writeJson-formatted end to end.
  const needleCompact = Buffer.from(`"${field}":"${value}"`);
  const needleSpaced = Buffer.from(`"${field}": "${value}"`);
  let found = null;
  const tmp = `${p}.tmp${process.pid}`;
  const dstFd = openSync(tmp, "w");
  let wroteAny = false;
  try {
    writeSync(dstFd, "[");
    forEachJsonArrayElement(p, (buf, start, end) => {
      let replaced = null;
      if (!found) {
        const view = buf.subarray(start, end);
        const idx = view.indexOf(needleCompact) !== -1 ? 0 : view.indexOf(needleSpaced);
        if (idx !== -1) {
          let obj;
          try { obj = JSON.parse(view.toString("utf8")); } catch { obj = null; }
          if (obj && obj[field] === value) {
            const updated = updater(obj);
            found = updated || obj;
            replaced = found;
          }
        }
      }
      if (wroteAny) writeSync(dstFd, ",");
      if (replaced) writeSync(dstFd, JSON.stringify(replaced));
      else writeSync(dstFd, buf, start, end - start);
      wroteAny = true;
    });
    writeSync(dstFd, "]");
  } finally { closeSync(dstFd); }
  if (found) { renameSync(tmp, p); _mtimeCache.delete(file); } // see appendJsonRecords above for why
  else { try { unlinkSync(tmp); } catch {} }
  return found;
}

// Same byte-copy philosophy, generalized to a bounded SET of ids (matched by
// the record's own "id" field) in one pass -- used for bulk operations like
// "mark these 30 inbox items done" where the ids are already known (e.g.
// from a small per-contact index file) rather than discovered by scanning
// this file. Cost per non-matching element is still just a handful of cheap
// indexOf checks (one per id) plus a raw byte copy, so this stays fast even
// against a multi-GB file as long as `ids` itself is small (tens, not
// millions). updater returning null means "delete this record" (it's
// dropped instead of rewritten); otherwise the returned/mutated object
// replaces it. Returns the array of updated (non-deleted) records so
// callers can tell which ones actually matched, e.g. to know which
// contacts to also patch in a per-contact index.
export function updateJsonArrayRecordsByIds(file, ids, updater) {
  const p = join(DATA_DIR, file);
  if (!existsSync(p) || !ids || !ids.length) return [];
  const idSet = new Set(ids);
  // Same compact-vs-pretty-printed gap as updateJsonArrayRecordByField above
  // (see its comment) -- a bulk import written via writeJson/flushJsonCache
  // (JSON.stringify(d, null, 2)) leaves "id": "value" WITH a space, which
  // the compact-only needle never matched.
  const needles = ids.flatMap(id => [Buffer.from(`"id":"${id}"`), Buffer.from(`"id": "${id}"`)]);
  const updated = [];
  let changed = false;
  const tmp = `${p}.tmp${process.pid}`;
  const dstFd = openSync(tmp, "w");
  let wroteAny = false;
  try {
    writeSync(dstFd, "[");
    forEachJsonArrayElement(p, (buf, start, end) => {
      const view = buf.subarray(start, end);
      let candidate = false;
      for (const needle of needles) { if (view.indexOf(needle) !== -1) { candidate = true; break; } }
      let dropped = false, toWrite = null;
      if (candidate) {
        let obj;
        try { obj = JSON.parse(view.toString("utf8")); } catch { obj = null; }
        if (obj && idSet.has(obj.id)) {
          const result = updater(obj);
          if (result === null) { dropped = true; changed = true; }
          else { toWrite = result || obj; updated.push(toWrite); changed = true; }
        }
      }
      if (dropped) return;
      if (wroteAny) writeSync(dstFd, ",");
      if (toWrite) writeSync(dstFd, JSON.stringify(toWrite));
      else writeSync(dstFd, buf, start, end - start);
      wroteAny = true;
    });
    writeSync(dstFd, "]");
  } finally { closeSync(dstFd); }
  if (changed) { renameSync(tmp, p); _mtimeCache.delete(file); } // see appendJsonRecords above for why
  else { try { unlinkSync(tmp); } catch {} }
  return updated;
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
      first, last, role: "admin", archived: false, footerTemplateId: createFooterForUser(first, last), createdAt: new Date().toISOString(),
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
      first, last, role, archived: false, footerTemplateId: createFooterForUser(first, last), createdAt: new Date().toISOString(),
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
  const footerMatch = p.match(/^\/api\/auth\/users\/([^/]+)\/footer$/);
  if (footerMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const { footerTemplateId } = await readJsonBody(req);
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === footerMatch[1]);
    if (!target) return sendJson(res, 404, { error: "User not found" });
    target.footerTemplateId = footerTemplateId || null;
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }

  // Per-user UI preferences (e.g. which contacts-table columns are visible
  // and what order they're in) -- merge-patch semantics, only the keys
  // present in the body are touched, so one page's save (e.g. column
  // order) never clobbers another page's preferences saved earlier. Keyed
  // to the logged-in user, not the browser, so it follows Lee/Alexis/Josh
  // across devices instead of being per-device like localStorage was.
  if (p === "/api/auth/me/preferences" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const body = await readJsonBody(req);
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === me.id);
    target.preferences = { ...(target.preferences || {}), ...body };
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true, preferences: target.preferences });
  }

  // Lightweight roster any logged-in user can read (not just admins) --
  // used by the Inbox compose panel to show who a reply will send as, and
  // that teammates exist even though only the session user is selectable.
  // No role/archived/footer internals, just enough to display a name+email.
  if (p === "/api/auth/team" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const users = readJson(USERS_FILE, []).filter(u => !u.archived);
    return sendJson(res, 200, { users: users.map(u => ({ id: u.id, first: u.first, last: u.last, email: u.email })) });
  }

  return false;
}
