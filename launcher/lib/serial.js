// One game-folder job at a time.
//
// The window's buttons (Update, Repair, Restore previous version, Check for
// updates, choosing a folder), the start-up checks, PLAY's last look for a
// release and the offline reconnect all read and write the game folder's
// state (lib/sync.js). Run side by side they undid each other: a check that
// was hashing while an update committed wrote the old version back, so the
// launcher offered the update again and the next sync dropped the backup that
// "Restore previous version" needs.
//
// createSerial(): run(fn) queues fn after every job already queued and
// resolves (or rejects) with its result; one failing job doesn't stop the
// next. createExclusive(): the user's actions (sync, restore, check) are
// claimed at once, before their first await, so a second click arriving
// while the first is still starting is refused instead of running twice.
"use strict";

function createSerial() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    run(fn) {
      pending++;
      const job = tail.then(() => fn());
      const done = () => { pending--; };
      tail = job.then(done, done);
      return job;
    },
    // Jobs queued or running.
    get pending() { return pending; }
  };
}

// messages: { [name]: what a refused second action is told while `name` runs }.
function createExclusive(messages = {}) {
  let current = null;
  return {
    async run(name, fn) {
      if (current) throw new Error(messages[current] || "Wait for the launcher to finish");
      current = name;
      try {
        return await fn();
      } finally {
        current = null;
      }
    },
    get current() { return current; }
  };
}

module.exports = { createSerial, createExclusive };
