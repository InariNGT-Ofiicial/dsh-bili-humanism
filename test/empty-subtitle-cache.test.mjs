import { wbiNav } from "./fixtures/wbi.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";

const bv = "BV0000000001";
const player = "/x/player/wbi/v2";
const subtitle = "/synthetic-empty-cache.json";
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
function fixture(t, options = {}) {
  const root =
    options.root || mkdtempSync(join(tmpdir(), "humanism-empty-cache-"));
  const state = { tracks: false, risk: false };
  const calls = [];
  const service = new Service(
    { dataDir: root, ...(options.limits ? { limits: options.limits } : {}) },
    {
      fetcher: async (url, request) => {
        const path = new URL(url).pathname;
        calls.push({ path, request });
        if (path === "/x/web-interface/view")
          return response({
            code: 0,
            data: {
              title: "Synthetic cache fixture",
              owner: { name: "Synthetic author", mid: 1 },
              pages: [{ page: 1, cid: 7, duration: 60 }],
            },
          });
        if (path === "/x/web-interface/nav") return response(wbiNav);
        if (path === player)
          return state.risk
            ? response({}, 412)
            : response({
                code: 0,
                data: {
                  subtitle: {
                    subtitles: state.tracks
                      ? [
                          {
                            lan: "zh-CN",
                            subtitle_url:
                              "https://aisubtitle.hdslb.com" + subtitle,
                          },
                        ]
                      : [],
                  },
                },
              });
        if (path === subtitle)
          return response({
            body: [{ from: 0, to: 58, content: "Synthetic recovered text" }],
          });
        assert.fail("Unexpected synthetic endpoint");
      },
    },
  );
  t.after(() => service.close());
  return { root, state, calls, service };
}
test("empty subtitle response is uncertain, not proof of absent subtitles", async (t) => {
  const f = fixture(t);
  const read = await f.service.read(bv);
  assert.equal(read.result.coverage.state, "read_failed");
  assert.equal(read.result.coverage.availability, "unconfirmed");
  assert.equal(read.result.attempts[0].state, "empty_unconfirmed");
  assert.equal(read.result.coverage.speech, "unknown");
  assert.equal(f.calls.length, 3, "No automatic retry or anonymous A2 request");
});
test("a later explicit read can recover after an empty response and then cache positive text", async (t) => {
  const f = fixture(t);
  await f.service.read(bv);
  assert.equal(
    f.service.store.db
      .prepare("SELECT count(*) AS n FROM cache WHERE key LIKE 'read-v3:%'")
      .get().n,
    0,
  );
  f.state.tracks = true;
  const recovered = await f.service.read(bv);
  assert.equal(recovered.result.route, "A1");
  assert.equal(recovered.result.cached, false);
  assert.equal(recovered.usage.requests, 4);
  const cached = await f.service.read(bv);
  assert.equal(cached.result.cached, true);
  assert.equal(cached.usage.requests, 0);
});
test("legacy empty six-hour cache is bypassed without deleting stored readings", async (t) => {
  const f = fixture(t);
  const empty = await f.service.read(bv);
  f.service.store.cachePut(`read-v2:${bv}:1:guest`, {
    ...empty.result,
    coverage: { ...empty.result.coverage, state: "no_subtitles" },
  });
  const existing = f.service.store.reading(empty.result.id);
  f.state.tracks = true;
  const read = await f.service.read(bv);
  assert.equal(read.result.route, "A1");
  assert.equal(read.result.cached, false);
  assert.deepEqual(f.service.store.reading(empty.result.id), existing);
});
test("negative cache bypass does not bypass risk pause or request budget", async (t) => {
  const f = fixture(t);
  await f.service.read(bv);
  f.state.risk = true;
  await assert.rejects(f.service.read(bv), (e) => e.code === "PLATFORM_PAUSED");
  const before = f.calls.length;
  await assert.rejects(
    f.service.read(bv),
    (e) => e.code === "PERSISTENT_PAUSE",
  );
  assert.equal(f.calls.length, before);
  const limited = fixture(t, { limits: { requests: 1 } });
  await assert.rejects(
    limited.service.read(bv),
    (e) => e.code === "REQUESTS_BUDGET",
  );
  assert.equal(limited.calls.length, 1);
});
