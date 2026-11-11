import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Budget } from "../lib/budget.mjs";
import { Network } from "../lib/network.mjs";
import { firstMediaBytes } from "../lib/visual-media.mjs";

const cdn = "https://synthetic.bilivideo.com/media.m4s";
const backup = "https://backup.bilivideo.com/backup.m4s";
const bytes = Buffer.from("SYNTHETIC_MEDIA_BODY");
async function fixture(t, handler) {
  const root = mkdtempSync(join(tmpdir(), "humanism-timeout-"));
  const timers = new Set(),
    stores = [],
    calls = [];
  const later = (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timers.add(timer);
    return timer;
  };
  const server = createServer((request, response) => {
    calls.push(request.url);
    handler(request, response, later);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    calls,
    network({ wallMs = 45000, signal } = {}) {
      const store = new Store(join(root, String(stores.length)));
      stores.push(store);
      const budget = new Budget(
        store,
        store.start(),
        { requests: 12, wallMs },
        signal,
      );
      // Only destination is substituted: native fetch, streaming and signals remain real.
      const fetcher = (url, options) =>
        fetch(
          `http://127.0.0.1:${server.address().port}${url.pathname}`,
          options,
        );
      return new Network(store, budget, { fetcher });
    },
  };
}
function stream(response, body, later, ms) {
  response.writeHead(200, { "Content-Length": body.length });
  response.write(body.subarray(0, 1));
  const timer = later(() => response.end(body.subarray(1)), ms);
  response.on("close", () => clearTimeout(timer));
}

test(
  "slow media body survives 15s; JSON bodies and stalled media headers still time out",
  { timeout: 35000 },
  async (t) => {
    let headerAttempts = 0;
    const f = await fixture(t, (request, response, later) => {
      if (request.url === "/headers.m4s") {
        if (++headerAttempts === 1) {
          const timer = later(() => response.end(bytes), 16200);
          response.on("close", () => clearTimeout(timer));
        } else response.end(bytes);
      } else
        stream(
          response,
          request.url.endsWith(".m4s") ? bytes : Buffer.from('{"code":0}'),
          later,
          16200,
        );
    });
    // Start together so the real 15-second protections need only one elapsed interval.
    const results = await Promise.allSettled([
      f.network().get(cdn, "media"),
      f.network().get("https://api.bilibili.com/x/web-interface/nav"),
      f
        .network()
        .get("https://aisubtitle.hdslb.com/synthetic.json", "subtitle"),
      f.network().get("https://synthetic.bilivideo.com/headers.m4s", "media"),
    ]);
    assert.equal(results[0].status, "fulfilled", results[0].reason?.code);
    assert.deepEqual(results[0].value, bytes);
    for (const result of results.slice(1, 3)) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.code, "BODY_READ_FAILED");
    }
    assert.equal(results[3].status, "fulfilled");
    assert.deepEqual(results[3].value, bytes);
    assert.equal(headerAttempts, 2);
  },
);

for (const mode of ["wall", "cancel"]) {
  test(`slow media obeys ${mode} without fetching a backup`, async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, (_request, response, later) => {
      stream(response, bytes, later, 1500);
      if (mode === "cancel") later(() => controller.abort(), 150);
    });
    const network = f.network({
      wallMs: mode === "wall" ? 300 : 5000,
      signal: controller.signal,
    });
    await assert.rejects(
      firstMediaBytes(network, network.budget, [cdn, backup]),
      { code: mode === "wall" ? "WALL_BUDGET" : "CANCELLED" },
    );
    // A tiny wall budget can expire before loopback accepts the first request.
    assert.ok(f.calls.length <= 1);
    assert.ok(f.calls.every((path) => path === "/media.m4s"));
  });
}
