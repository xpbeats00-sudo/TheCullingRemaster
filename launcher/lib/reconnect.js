// Getting back online after an offline start: tries again with growing waits
// (5 s, 10 s, 20 s, 40 s, then every 60 s) until a try succeeds, and at once
// when the player presses Retry.
"use strict";

const DELAYS = [5000, 10000, 20000, 40000, 60000];

// attempt() resolves true when back online (false or a throw: still
// offline). onOnline() runs after a successful try.
function createReconnect(attempt, { delays = DELAYS, onOnline = () => {} } = {}) {
  let timer = null;
  let tries = 0;
  let inflight = null;

  function schedule() {
    if (timer) return;
    const ms = delays[Math.min(tries, delays.length - 1)];
    tries++;
    timer = setTimeout(() => { timer = null; run(); }, ms);
    if (timer.unref) timer.unref();
  }

  function run() {
    if (inflight) return inflight;
    inflight = (async () => {
      let ok = false;
      try { ok = !!(await attempt()); } catch { ok = false; }
      inflight = null;
      if (ok) { tries = 0; onOnline(); } else schedule();
      return ok;
    })();
    return inflight;
  }

  return {
    // Starts trying (offline at start-up); nothing if a try is pending.
    start: schedule,
    // Tries now (Retry); resolves true when back online.
    now() { clearTimeout(timer); timer = null; return run(); },
    // Back online some other way: no more tries until start() again.
    cancel() { clearTimeout(timer); timer = null; tries = 0; },
    get pending() { return !!timer || !!inflight; }
  };
}

module.exports = { createReconnect, DELAYS };
