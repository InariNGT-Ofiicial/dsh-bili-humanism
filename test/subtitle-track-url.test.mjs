import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import { wbiNav } from "./fixtures/wbi.mjs";

const bv = "BV0000000001";
const cdn = "https://aisubtitle.hdslb.com/synthetic-valid.json";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "humanism-track-url-"));
  const credentialPath = join(root, "synthetic-credential.json");
  writeFileSync(
    credentialPath,
    JSON.stringify({ sessdata: "SYNTHETIC_TRACK_COOKIE" }),
  );
  const calls = [];
  const service = new Service(
    { dataDir: root, ...(options.credential ? { credentialPath } : {}) },
    {
      fetcher: async (raw, request) => {
        const u = new URL(raw);
        calls.push({ url: u, request });
        if (u.pathname === "/x/web-interface/view")
          return json({
            code: 0,
            data: {
              bvid: bv,
              aid: 17,
              owner: { mid: 1 },
              pages: [{ page: 1, cid: 7, duration: 60 }],
            },
          });
        if (u.pathname === "/x/web-interface/nav") return json(wbiNav);
        if (u.pathname === "/x/player/wbi/v2")
          return json({
            code: 0,
            data: {
              bvid: bv,
              aid: 17,
              cid: 7,
              subtitle: {
                subtitles: options.tracks || [
                  { lan: "zh-CN", subtitle_url: cdn },
                ],
              },
            },
          });
        if (u.hostname === "aisubtitle.hdslb.com")
          return json(
            {
              body: [{ from: 0, to: 58, content: "Synthetic usable subtitle" }],
            },
            options.cdnStatus || 200,
          );
        if (u.pathname === "/x/web-interface/view/conclusion/get")
          return json({
            code: 0,
            data: {
              model_result: {
                subtitle: [
                  {
                    start_timestamp: 0,
                    end_timestamp: 5,
                    content: "Synthetic A2 fallback",
                  },
                ],
              },
            },
          });
        assert.fail("Unexpected synthetic endpoint");
      },
    },
  );
  t.after(() => service.close());
  return { service, calls };
}
const cacheRows = (service) =>
  service.store.db.prepare("SELECT count(*) AS n FROM cache").get().n;

test("missing track addresses do not hide a later usable track", async (t) => {
  const f = fixture(t, {
    tracks: [
      { lan: "zh-CN", subtitle_url: "" },
      null,
      { lan: "zh-CN" },
      { lan: "zh-CN", subtitle_url: 12 },
      { lan: "zh-CN", subtitle_url: "  \t " },
      { lan: "ai-zh", subtitle_url: cdn },
    ],
  });
  const r = await f.service.read(bv);
  assert.equal(r.result.route, "A1");
  assert.equal(r.result.segments[0].text, "Synthetic usable subtitle");
  assert.equal(r.usage.requests, 4);
  assert.equal(
    f.calls.filter(({ url }) => url.hostname === "aisubtitle.hdslb.com").length,
    1,
  );
  assert.equal(cacheRows(f.service), 1);
});

test("only missing addresses remain unconfirmed without guest A2 or negative cache", async (t) => {
  const f = fixture(t, {
    tracks: [{ lan: "zh-CN", subtitle_url: "" }, { lan: "ai-zh" }],
  });
  const r = await f.service.read(bv);
  assert.equal(r.result.route, "none");
  assert.equal(r.result.attempts[0].state, "empty_unconfirmed");
  assert.equal(r.result.coverage.availability, "unconfirmed");
  assert.equal(r.usage.requests, 3);
  assert.equal(cacheRows(f.service), 0);
});

test("only missing addresses allow the existing credentialed signed A2 fallback", async (t) => {
  const f = fixture(t, {
    credential: true,
    tracks: [{ lan: "zh-CN", subtitle_url: "" }],
  });
  const r = await f.service.read(bv);
  assert.equal(r.result.route, "A2");
  assert.equal(r.result.attempts[0].state, "empty_unconfirmed");
  assert.equal(r.usage.requests, 4);
  assert.equal(
    f.calls.filter(({ url }) => url.pathname === "/x/web-interface/nav").length,
    1,
  );
  assert.ok(
    !f.calls.some(({ url }) => url.hostname === "aisubtitle.hdslb.com"),
  );
});

test("protocol-relative addresses are trimmed before HTTPS normalization", async (t) => {
  const f = fixture(t, {
    credential: true,
    tracks: [
      {
        lan: "zh-CN",
        subtitle_url: "  //aisubtitle.hdslb.com/synthetic-valid.json\t",
      },
    ],
  });
  const r = await f.service.read(bv);
  assert.equal(r.result.route, "A1");
  assert.equal(r.usage.requests, 4);
  assert.equal(f.calls.at(-1).url.href, cdn);
  assert.equal(f.calls.at(-1).request.headers.Cookie, undefined);
});

test("a nonempty denied address is still fatal and never skipped to another track or A2", async (t) => {
  const f = fixture(t, {
    credential: true,
    tracks: [
      { lan: "zh-CN", subtitle_url: "https://127.0.0.1/private.json" },
      { lan: "ai-zh", subtitle_url: cdn },
    ],
  });
  await assert.rejects(f.service.read(bv), (e) => e.code === "URL_DENIED");
  assert.equal(f.calls.length, 3);
  assert.equal(cacheRows(f.service), 0);
});

test("CDN risk still stops signed A2 and preserves pause", async (t) => {
  const f = fixture(t, { credential: true, cdnStatus: 412 });
  await assert.rejects(f.service.read(bv), (e) => e.code === "PLATFORM_PAUSED");
  assert.equal(f.calls.length, 4);
  assert.equal(f.service.status().pause.reason, "HTTP_412");
  await assert.rejects(
    f.service.read(bv),
    (e) => e.code === "PERSISTENT_PAUSE",
  );
  assert.equal(f.calls.length, 4);
  assert.equal(cacheRows(f.service), 0);
});

test("a 32-hex opaque name with 16 leading digits is not asserted to encode video IDs", async (t) => {
  const name = "1234567890123456" + "a".repeat(16);
  assert.equal(name.length, 32);
  assert.match(name, /^[0-9a-f]{32}$/);
  const f = fixture(t, {
    tracks: [
      {
        lan: "ai-zh",
        subtitle_url:
          "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/" + name,
      },
    ],
  });
  const r = await f.service.read(bv);
  assert.equal(r.result.route, "A1");
  assert.equal(r.result.subtitleSource.semanticVerification, "unverified");
  assert.deepEqual(r.result.subtitleSource.identityFields, [
    "bvid",
    "cid",
    "aid",
  ]);
});
