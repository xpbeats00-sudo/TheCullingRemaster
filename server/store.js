// Saving JSON data files (profiles.json, sessions.json) safely and cheaply.
//
// - Atomic: the data is written to a temp file, flushed to disk (fsync) and
//   renamed over the real file, so a crash or power cut mid-write leaves
//   either the old file or the new one, never a truncated one.
// - Coalesced: a change only marks the file dirty. One write happens at most
//   every `delayMs` (1 s on the server), however many changes arrive, so a
//   burst of match results costs one write, not one per request.
// - Off the event loop: the periodic write does its file I/O asynchronously
//   (libuv thread pool); only JSON.stringify and the final rename (a metadata
//   operation) run on the main thread.
// - Nothing lost on a graceful stop: flushSync() writes any pending change
//   synchronously, and is called on SIGINT / SIGTERM / SIGBREAK / SIGHUP and
//   on exit. A hard kill loses at most the last `delayMs` plus one write.
"use strict";

const fs = require("fs");
const path = require("path");

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Rename, retrying briefly: on Windows a reader (antivirus, backup, an editor)
// holding the target open makes MoveFileEx fail for a moment. This one sleeps
// on the main thread between tries (up to ~300 ms): only for the synchronous
// writes (flushSync at shutdown, writeAtomicSync); the periodic write uses
// renameRetry, which waits with timers.
function renameSyncRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (!RENAME_RETRY_CODES.has(e.code) || attempt >= 5) throw e;
      sleepSync(20 * (attempt + 1));
    }
  }
}

// The same retries without blocking the event loop: a timer between tries.
// Each try is still a synchronous rename (one metadata call), and `wanted()`
// is asked before each, so a synchronous flush that wrote newer data during a
// wait is never overwritten. Resolves with whether it renamed, and the time
// spent in the tries themselves.
async function renameRetry(from, to, wanted = () => true) {
  let blockedMs = 0;
  for (let attempt = 0; ; attempt++) {
    if (!wanted()) return { renamed: false, blockedMs };
    const t0 = performance.now();
    try { fs.renameSync(from, to); return { renamed: true, blockedMs: blockedMs + performance.now() - t0 }; } catch (e) {
      blockedMs += performance.now() - t0;
      if (!RENAME_RETRY_CODES.has(e.code) || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

// fsync the directory so the rename itself is durable (POSIX only: Windows
// can't open a directory for fsync, and NTFS journals the rename).
function syncDirSync(dir) {
  if (process.platform === "win32") return;
  let fd;
  try { fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); } catch { /* best effort */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// One-off synchronous atomic write (rarely-changing files such as levels.json).
function writeAtomicSync(file, text) {
  const tmp = file + ".tmp-sync";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameSyncRetry(tmp, file);
  syncDirSync(path.dirname(file));
}

class CoalescedJsonFile {
  // serialize: () => string (the whole file's contents, read at write time).
  constructor(file, serialize, { delayMs = 1000, onError = () => {}, now = Date.now } = {}) {
    this.file = file;
    this.serialize = serialize;
    this.delayMs = delayMs;
    this.onError = onError;
    this.now = now;
    this.dirty = false;
    this.timer = null;
    this.writing = null;            // promise of the write in flight
    this.generation = 0;            // bumped by every synchronous write
    this.lastWriteAt = 0;
    this.closed = false;
    // blockingMs: time on the event loop (stringify + rename); writeMs: the
    // whole write including the asynchronous file I/O and fsync.
    this.stats = { writes: 0, syncWrites: 0, changes: 0, errors: 0, lastBytes: 0, lastSerializeMs: 0,
      lastBlockingMs: 0, maxBlockingMs: 0, lastWriteMs: 0, maxWriteMs: 0 };
    // Temp files left by a crash mid-write are never the real data.
    for (const suffix of [".tmp", ".tmp-sync"]) {
      try { fs.unlinkSync(file + suffix); } catch { /* none */ }
    }
  }

  // Something changed: write it within delayMs (unless a write is already due).
  markDirty() {
    this.stats.changes++;
    this.dirty = true;
    if (this.closed) return this.flushSync();
    if (this.delayMs <= 0) return this.flushSync();
    this.schedule();
  }

  schedule() {
    if (this.timer || this.writing || !this.dirty) return;
    // At most one write per delayMs: wait out the rest of the interval.
    const wait = Math.max(0, Math.min(this.delayMs, this.lastWriteAt + this.delayMs - this.now()));
    this.timer = setTimeout(() => { this.timer = null; this.writeAsync(); }, Math.max(wait, 1));
    // The pending write must not keep a stopping process alive; flushSync covers it.
    if (this.timer.unref) this.timer.unref();
  }

  async writeAsync() {
    if (!this.dirty || this.writing || this.closed) return;
    const gen = this.generation;
    const t0 = performance.now();
    let text;
    try { text = this.serialize(); } catch (e) { this.fail(e); return; }
    const t1 = performance.now();
    this.dirty = false;             // changes from here on need another write
    this.lastWriteAt = this.now();
    const tmp = this.file + ".tmp";
    // this.writing: the whole write, file I/O and rename (flush() waits on it).
    this.writing = (async () => {
      const fh = await fs.promises.open(tmp, "w");
      try {
        await fh.writeFile(text);
        await fh.sync();
      } finally {
        await fh.close();
      }
      // Each rename try is synchronous, so a shutdown flush can never
      // interleave with one; between tries (a reader holding the file) the
      // event loop runs, and a flush that wrote newer data meanwhile wins.
      const r = await renameRetry(tmp, this.file, () => gen === this.generation && !this.closed);
      if (!r.renamed) {
        // A synchronous flush (shutdown) wrote newer data meanwhile: this
        // write is stale, don't rename it over the newer file.
        try { fs.unlinkSync(tmp); } catch { /* gone */ }
        return;
      }
      this.recordWrite(text.length, t1 - t0, performance.now() - t0, (t1 - t0) + r.blockedMs);
    })();
    try {
      await this.writing;
    } catch (e) {
      this.dirty = true;            // keep the change; try again next interval
      this.fail(e);
    } finally {
      this.writing = null;
    }
    if (!this.closed) this.schedule();
  }

  recordWrite(bytes, serializeMs, totalMs, blockingMs) {
    this.stats.writes++;
    this.stats.lastBytes = bytes;
    this.stats.lastSerializeMs = +serializeMs.toFixed(3);
    this.stats.lastBlockingMs = +blockingMs.toFixed(3);
    this.stats.maxBlockingMs = Math.max(this.stats.maxBlockingMs, this.stats.lastBlockingMs);
    this.stats.lastWriteMs = +totalMs.toFixed(3);
    this.stats.maxWriteMs = Math.max(this.stats.maxWriteMs, this.stats.lastWriteMs);
  }

  fail(e) {
    this.stats.errors++;
    try { this.onError(e); } catch { /* never throw from the saver */ }
  }

  // Write now, synchronously, if anything is unsaved (or `force`).
  flushSync(force = false) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty && !force) return false;
    this.generation++;              // any async write in flight is now stale
    const t0 = performance.now();
    try {
      const text = this.serialize();
      const t1 = performance.now();
      writeAtomicSync(this.file, text);
      this.dirty = false;
      this.lastWriteAt = this.now();
      this.stats.syncWrites++;
      const total = performance.now() - t0;
      this.recordWrite(text.length, t1 - t0, total, total);
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  // Waits until everything changed so far is on disk (asynchronously).
  async flush() {
    if (this.writing) await this.writing.catch(() => {});
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dirty) await this.writeAsync();
  }

  // Final synchronous flush; later changes are written immediately.
  close() {
    const wrote = this.flushSync();
    this.closed = true;
    return wrote;
  }
}

module.exports = { CoalescedJsonFile, writeAtomicSync, renameSyncRetry, renameRetry };
