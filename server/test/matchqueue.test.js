// The game's own queue request: Victory.exe posts
// "ticket=..&authType=..&build=..&appid=..&userid=..&queueName=..&goodFilters=..&badFilters=.."
// (form-encoded, camelCase queueName) to /api/matchqueue. The server must
// read that queue, or every playlist (Duo, Ranked, Showdown) starts Solo.
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

const STEAM = "76561190000000901";

function gameBody(queue) {
  return "ticket=t&authType=steam&build=1&appid=437220&userid=" + STEAM +
    "&queueName=" + encodeURIComponent(queue) + "&goodFilters=&badFilters=";
}

(async () => {
  const srv = startServer();
  const sockets = [];
  try {
    await srv.ready();
    const a = await srv.connect(await srv.login("steam:" + STEAM));
    sockets.push(a);

    async function queue(name, contentType) {
      const lobby = next(a, "remaster-lobby");
      const ready = next(a, "match-ready");
      const r = await srv.request("POST", "/api/matchqueue", gameBody(name), { "Content-Type": contentType });
      assert.strictEqual(r.status, 200);
      return { reply: r.json, lobby: await lobby, ready: await ready };
    }

    await test("Duo from the game's form body starts the pairs mode", async () => {
      const { reply, lobby, ready } = await queue("ffa_jungle_coop2", "application/x-www-form-urlencoded");
      assert.strictEqual(reply.queueName, "ffa_jungle_coop2");
      assert.strictEqual(lobby.queue, "coop2", "the lobby is a Duo lobby");
      assert.strictEqual(ready.gameServer, "duo:0");
    });

    await test("Prison Duo with no content type (raw text body) too", async () => {
      const { lobby, ready } = await queue("ffa_prison_coop2", "text/plain");
      assert.strictEqual(lobby.queue, "coop2");
      assert.strictEqual(ready.gameServer, "duo:1");
    });

    await test("Trios and Quads start the pairs mode with their team size (trio:/quad:<map>)", async () => {
      for (const [name, mode, want] of [["ffa_jungle_coop3", "coop3", "trio:0"], ["ffa_prison_coop3", "coop3", "trio:1"],
        ["ffa_jungle_coop4", "coop4", "quad:0"], ["ffa_prison_coop4", "coop4", "quad:1"]]) {
        const { lobby, ready } = await queue(name, "application/x-www-form-urlencoded");
        assert.strictEqual(lobby.queue, mode, name);
        assert.strictEqual(ready.gameServer, want, name);
      }
    });

    await test("Solo stays Solo", async () => {
      const { lobby, ready } = await queue("ffa_jungle", "application/x-www-form-urlencoded");
      assert.strictEqual(lobby.queue, "ffa");
      assert.strictEqual(ready.gameServer, "offline:0");
    });

    await test("Showdown from the game's body starts a round, not Solo", async () => {
      const state = next(a, "remaster-showdown");
      const ready = next(a, "match-ready");
      const r = await srv.request("POST", "/api/matchqueue", gameBody("showdown"), { "Content-Type": "application/x-www-form-urlencoded" });
      assert.strictEqual(r.json.queueName, "showdown");
      assert.strictEqual((await state).phase, "round");
      assert.strictEqual((await ready).gameServer, "showdown:1v1");
    });

    console.log("all %d matchqueue tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
