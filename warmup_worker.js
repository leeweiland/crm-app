// Runs on its own OS thread (spawned via worker_threads, see server.js) --
// unlike the query-level warmup attempt this replaces, a slow disk read
// here genuinely cannot block the main thread's event loop no matter how
// long it takes, because it isn't running on that thread at all.
//
// Deliberately a raw sequential file read, not a real SQLite query: the
// goal is only to pull crm_prototype.db's bytes into the OS's page cache
// before a real user's query needs them, and a straight front-to-back
// read does that more thoroughly (and likely faster, sequential access
// beats a B-tree's scattered random access for the same total bytes) than
// replaying the sidebar's own query would. Once the OS page cache is warm,
// ANY process reading this file benefits, including the main thread's own
// later synchronous queries -- this doesn't need to share a DB connection
// with the server to help it.
import { existsSync, openSync, readSync, closeSync } from "fs";
import { workerData } from "worker_threads";

const t0 = Date.now();
const path = workerData?.dbPath;
try {
  if (path && existsSync(path)) {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let pos = 0, n;
    do {
      n = readSync(fd, buf, 0, buf.length, pos);
      pos += n;
    } while (n > 0);
    closeSync(fd);
    console.log(`[warmup-worker] read ${pos} bytes in ${Date.now() - t0}ms`);
  }
} catch (e) {
  console.error("[warmup-worker] failed:", e.message);
}
