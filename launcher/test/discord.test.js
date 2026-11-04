// Discord presence: a fake Discord on a local pipe gets the handshake with the
// application id, then the activity with the mask art; stop() clears it.
// Without Discord or an application id nothing happens.
"use strict";

const assert = require("assert");
const net = require("net");
const discord = require("../lib/discord");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

const PIPE = "\\\\?\\pipe\\culling-discord-test-" + process.pid + "-";

// A fake Discord on pipe <prefix>0: records frames and answers the handshake.
function fakeDiscord(prefix, { answer = "READY" } = {}) {
  const frames = [];
  const waiters = [];
  const server = net.createServer((sock) => {
    sock.on("data", discord.reader((op, body) => {
      frames.push({ op, body });
      if (op === 0) sock.write(answer === "READY" ? discord.frame(1, { cmd: "DISPATCH", evt: "READY", data: { v: 1 } })
        : discord.frame(2, { code: 4000, message: "Invalid client ID" }));
      while (waiters.length && waiters[0].n <= frames.length) waiters.shift().resolve();
    }));
    sock.on("error", () => {});
  });
  server.listen(prefix + "0");
  return {
    frames,
    until(n) { return n <= frames.length ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve })); },
    close() { return new Promise((r) => server.close(r)); }
  };
}

(async () => {
  try {
    await test("frames round-trip through the reader, split across chunks", async () => {
      const got = [];
      const read = discord.reader((op, body) => got.push([op, body]));
      const a = discord.frame(1, { x: 1 }), b = discord.frame(0, { y: "é" });
      const all = Buffer.concat([a, b]);
      read(all.subarray(0, 5)); read(all.subarray(5, 20)); read(all.subarray(20));
      assert.deepStrictEqual(got, [[1, { x: 1 }], [0, { y: "é" }]]);
    });

    await test("the activity shows the mask art, play time and https links only", async () => {
      const a = discord.activity({ started: 1700000000123, links: { discord: "https://discord.com/invite/x", website: "http://no" } });
      assert.strictEqual(a.assets.large_image, discord.ASSET);
      assert.strictEqual(a.timestamps.start, 1700000000);
      assert.deepStrictEqual(a.buttons, [{ label: "Join the Discord", url: "https://discord.com/invite/x" }]);
      assert.ok(!/bot/i.test(JSON.stringify(a)), "no player-facing text mentions bots");
    });

    await test("start() handshakes with the app id and sets the activity; stop() clears it", async () => {
      const fake = fakeDiscord(PIPE + "a");
      const p = discord.createPresence({ appId: "123456789", pipe: PIPE + "a", pid: 4242, links: { discord: "https://discord.com/invite/x" } });
      p.start();
      await fake.until(2);
      assert.deepStrictEqual(fake.frames[0], { op: 0, body: { v: 1, client_id: "123456789" } });
      const set = fake.frames[1].body;
      assert.strictEqual(set.cmd, "SET_ACTIVITY");
      assert.strictEqual(set.args.pid, 4242);
      assert.strictEqual(set.args.activity.assets.large_image, "mask");
      assert.ok(set.nonce);
      p.stop();
      await fake.until(3);
      assert.strictEqual(fake.frames[2].body.args.activity, null, "cleared");
      await fake.close();
    });

    await test("Discord not running: start() fails quietly and retries", async () => {
      const p = discord.createPresence({ appId: "1", pipe: PIPE + "none", retryMs: 50, timeoutMs: 200 });
      p.start();
      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(p.connected, false);
      // Discord starts later: the retry finds it.
      const fake = fakeDiscord(PIPE + "none");
      await fake.until(2);
      assert.strictEqual(fake.frames[1].body.cmd, "SET_ACTIVITY");
      p.stop();
      await fake.close();
    });

    await test("a refused application id does not throw", async () => {
      const fake = fakeDiscord(PIPE + "bad", { answer: "ERROR" });
      const p = discord.createPresence({ appId: "bad", pipe: PIPE + "bad", retryMs: 60000, timeoutMs: 300 });
      p.start();
      await fake.until(1);
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(p.connected, false);
      p.stop();
      await fake.close();
    });

    await test("no application id: presence is off and start() does nothing", async () => {
      const p = discord.createPresence({ appId: "" });
      assert.strictEqual(p.enabled, false);
      p.start();
      assert.strictEqual(p.connected, false);
    });

    console.log("all %d discord tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  }
})();
