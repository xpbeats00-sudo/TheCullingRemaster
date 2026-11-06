// Telemetry for the account server: what /metrics reports (loopback only).
//
// Cheap enough to leave on in production: counters per minute, a bounded
// sample of latencies per route / socket event, Node's own event-loop delay
// histogram, and process CPU / memory.
"use strict";

const { monitorEventLoopDelay, performance } = require("perf_hooks");

const MINUTE = 60 * 1000;
const SAMPLES_PER_KEY = 2048;       // latency samples kept per route per minute
const MAX_KEYS = 200;               // distinct routes / events tracked

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const round = (n, d = 2) => +Number(n).toFixed(d);

// Latencies of one route or event within one minute: a uniform random sample
// (reservoir) of at most SAMPLES_PER_KEY values, plus exact count/max/errors.
class LatencyBucket {
  constructor() { this.count = 0; this.errors = 0; this.max = 0; this.sum = 0; this.samples = []; }
  add(ms, error) {
    this.count++;
    this.sum += ms;
    if (error) this.errors++;
    if (ms > this.max) this.max = ms;
    if (this.samples.length < SAMPLES_PER_KEY) this.samples.push(ms);
    else {
      const j = Math.floor(Math.random() * this.count);
      if (j < SAMPLES_PER_KEY) this.samples[j] = ms;
    }
  }
  summary() {
    const s = this.samples.slice().sort((a, b) => a - b);
    return { count: this.count, errors: this.errors, meanMs: round(this.count ? this.sum / this.count : 0, 3),
      p50Ms: round(percentile(s, 50), 3), p95Ms: round(percentile(s, 95), 3), p99Ms: round(percentile(s, 99), 3),
      maxMs: round(this.max, 3) };
  }
}

class Window {
  constructor(start) {
    this.start = start;
    this.requests = 0;
    this.socketEvents = 0;
    this.errors = { http5xx: 0, http4xx: 0, rateLimited: 0, socketHandler: 0, socketDropped: 0, process: 0, save: 0, timer: 0, backup: 0 };
    this.routes = new Map();
    this.events = new Map();
  }
  bucket(map, key) {
    let b = map.get(key);
    if (!b) {
      if (map.size >= MAX_KEYS) key = "(other)";
      b = map.get(key);
      if (!b) map.set(key, (b = new LatencyBucket()));
    }
    return b;
  }
}

function createMetrics({ now = Date.now, gauges = () => ({}), keepMinutes = 15 } = {}) {
  const startedAt = now();
  const eld = monitorEventLoopDelay({ resolution: 10 });     // reset every minute
  const eldTotal = monitorEventLoopDelay({ resolution: 10 });  // since start
  eld.enable();
  eldTotal.enable();
  let current = new Window(startedAt);
  const history = [];               // completed minutes, newest last
  const totals = { requests: 0, socketEvents: 0, errors: {} };
  let cpuMark = process.cpuUsage();
  let cpuMarkAt = now();
  let lastMinuteCpu = null;
  let lastMinuteEld = null;
  // Event-loop utilization: the share of wall time the loop spent running
  // code rather than waiting. Unlike the delay histogram it doesn't depend on
  // timer resolution (Windows timers tick every ~15.6 ms, so an idle loop
  // already shows ~15.5 ms "delay" there).
  const eluStart = performance.eventLoopUtilization();
  let eluMark = eluStart;
  let lastMinuteElu = null;
  const elu = (since) => round(performance.eventLoopUtilization(since).utilization, 4);

  function eldSummary(h = eld) {
    // Values are nanoseconds; report milliseconds.
    const ms = (ns) => round(ns / 1e6, 3);
    return { p50Ms: ms(h.percentile(50)), p95Ms: ms(h.percentile(95)), p99Ms: ms(h.percentile(99)),
      maxMs: ms(h.max), meanMs: ms(h.mean) };
  }

  function cpuSince(mark, markAt) {
    const d = process.cpuUsage(mark);
    const wallMs = Math.max(1, now() - markAt);
    return { userMs: round(d.user / 1000, 1), systemMs: round(d.system / 1000, 1),
      percentOfOneCore: round(((d.user + d.system) / 1000 / wallMs) * 100, 1), overMs: wallMs };
  }

  // Close the current minute (called on a timer and before every report).
  function roll() {
    const t = now();
    while (t - current.start >= MINUTE) {
      lastMinuteCpu = cpuSince(cpuMark, cpuMarkAt);
      cpuMark = process.cpuUsage();
      cpuMarkAt = t;
      lastMinuteEld = eldSummary();
      eld.reset();
      lastMinuteElu = elu(eluMark);
      eluMark = performance.eventLoopUtilization();
      // Completed minutes keep their counts and summary only, not the samples.
      history.push({ requests: current.requests, socketEvents: current.socketEvents, summary: windowSummary(current, 1) });
      if (history.length > keepMinutes) history.shift();
      current = new Window(current.start + MINUTE);
      // A long idle gap: skip empty minutes rather than loop through them.
      if (t - current.start >= MINUTE) {
        history.push({ requests: 0, socketEvents: 0, summary: windowSummary(new Window(t - MINUTE - ((t - startedAt) % MINUTE)), 1) });
        if (history.length > keepMinutes) history.shift();
        current = new Window(t - ((t - startedAt) % MINUTE));
      }
    }
  }
  const timer = setInterval(roll, 5000);
  timer.unref();

  const tick = () => { if (now() - current.start >= MINUTE) roll(); };

  function error(kind, n = 1) {
    tick();
    current.errors[kind] = (current.errors[kind] || 0) + n;
    totals.errors[kind] = (totals.errors[kind] || 0) + n;
  }

  function request(route, status, ms) {
    tick();
    current.requests++;
    totals.requests++;
    const isErr = status >= 500;
    if (isErr) error("http5xx");
    else if (status === 429) error("rateLimited");
    else if (status >= 400) error("http4xx");
    current.bucket(current.routes, route).add(ms, isErr);
  }

  function socketEvent(name, ms, failed) {
    tick();
    current.socketEvents++;
    totals.socketEvents++;
    if (failed) error("socketHandler");
    current.bucket(current.events, name).add(ms, failed);
  }

  function windowSummary(w, minutes) {
    const per = (map) => Object.fromEntries([...map].sort((a, b) => b[1].count - a[1].count).map(([k, b]) => [k, b.summary()]));
    return { from: new Date(w.start).toISOString(), minutes, requests: w.requests, socketEvents: w.socketEvents,
      errors: w.errors, routes: per(w.routes), socketEventsByName: per(w.events) };
  }

  function report() {
    roll();
    const mem = process.memoryUsage();
    const mb = (b) => round(b / 1048576, 1);
    const last = history[history.length - 1];
    const recent = history.slice(-5);
    return {
      now: new Date(now()).toISOString(),
      uptimeSeconds: Math.round((now() - startedAt) / 1000),
      node: process.version,
      pid: process.pid,
      ...gauges(),
      eventLoopDelay: { lastMinute: lastMinuteEld, sinceLastMinute: eldSummary(), sinceStart: eldSummary(eldTotal),
        timerTickNote: process.platform === "win32" ? "Windows timer resolution (~15.6 ms) is included in these values" : undefined },
      eventLoopUtilization: { lastMinute: lastMinuteElu, sinceLastMinute: elu(eluMark), sinceStart: elu(eluStart) },
      memoryMB: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external),
        arrayBuffers: mb(mem.arrayBuffers) },
      cpu: { lastMinute: lastMinuteCpu, sinceLastMinute: cpuSince(cpuMark, cpuMarkAt),
        total: cpuSince({ user: 0, system: 0 }, startedAt) },
      rates: {
        lastMinute: last ? { requests: last.requests, socketEvents: last.socketEvents } : null,
        perMinuteLast5: recent.length ? {
          requests: round(recent.reduce((n, w) => n + w.requests, 0) / recent.length, 1),
          socketEvents: round(recent.reduce((n, w) => n + w.socketEvents, 0) / recent.length, 1)
        } : null
      },
      totals,
      lastMinute: last ? last.summary : null,
      currentMinute: windowSummary(current, round((now() - current.start) / MINUTE, 2))
    };
  }

  function stop() { clearInterval(timer); eld.disable(); eldTotal.disable(); }

  return { request, socketEvent, error, report, stop };
}

// Who may read /metrics: a loopback connection carrying no proxy headers.
// Caddy reaches the server over loopback too, but always adds
// X-Forwarded-For, so nothing proxied from the internet is ever answered.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded',
  'x-real-ip', 'via'];
function metricsAllowed(remoteAddress, headers) {
  const ip = String(remoteAddress || '').replace(/^::ffff:/, '');
  if (ip !== '127.0.0.1' && ip !== '::1') return false;
  return !PROXY_HEADERS.some((h) => Object.prototype.hasOwnProperty.call(headers || {}, h));
}

module.exports = { createMetrics, metricsAllowed, percentile, LatencyBucket, PROXY_HEADERS };
