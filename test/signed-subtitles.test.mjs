import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import { digest } from "../lib/store.mjs";

const bv = "BV0000000001";
const secret = "SYNTHETIC_SIGNED_COOKIE";
const nav = "/x/web-interface/nav";
const signed = "/x/player/wbi/v2";
const legacy = "/x/player/v2";
const wi = {
  img_url: "https://i0.hdslb.com/" + "a".repeat(32) + ".png",
  sub_url: "https://i0.hdslb.com/" + "b".repeat(32) + ".png",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "humanism-signed-subtitles-"));
  const credentialPath = join(root, "synthetic-credential.json");
  writeFileSync(credentialPath, JSON.stringify({ sessdata: secret }));
  const calls = [];
  const service = new Service(
    {
      dataDir: root,
      ...(options.anonymous ? {} : { credentialPath }),
      ...(options.limits ? { limits: options.limits } : {}),
    },
    {
      fetcher: async (url, request) => {
        const u = new URL(url);
        calls.push({ u, request });
        if (options.responses?.[u.pathname])
          return options.responses[u.pathname]();
        if (u.pathname === "/x/web-interface/view")
          return json({
            code: 0,
            data: {
              bvid: bv,
              aid: 17,
              title: "Synthetic expected subject",
              owner: { mid: 1 },
              pages: [{ page: 1, cid: 7, duration: 60 }],
            },
          });
        if (u.pathname === nav)
          return json({
            code: options.anonymous ? -101 : 0,
            data: {
              isLogin: !options.anonymous,
              wbi_img: wi,
            },
          });
        if ([signed, legacy].includes(u.pathname))
          return json({
            code: 0,
            data: {
              bvid: bv,
              aid: 17,
              cid: 7,
              subtitle: {
                subtitles: options.empty
                  ? []
                  : [
                      {
                        lan: "ai-zh",
                        // Legitimate signed tracks can use opaque paths with no video IDs.
                        subtitle_url:
                          "https://aisubtitle.hdslb.com/" +
                          (u.pathname === signed
                            ? "opaque-correct"
                            : "opaque-foreign") +
                          ".json",
                      },
                    ],
              },
            },
          });
        if (u.hostname === "aisubtitle.hdslb.com")
          return json({
            body: [
              {
                from: 0,
                to: 58,
                content: u.pathname.includes("correct")
                  ? "Synthetic expected subject"
                  : "Synthetic unrelated subject",
              },
            ],
          });
        if (u.pathname === "/x/web-interface/view/conclusion/get")
          return json({
            code: 0,
            data: {
              model_result: {
                subtitle: [
                  {
                    start_timestamp: 0,
                    end_timestamp: 5,
                    content: "Synthetic A2 fragment",
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
  return { service, calls, root };
}

for (const anonymous of [false, true])
  test(`signed A1 avoids a plausible foreign track (${anonymous ? "guest" : "credential"})`, async (t) => {
    const f = fixture(t, { anonymous });
    const before = Math.floor(Date.now() / 1000);
    const r = await f.service.read(bv);
    assert.equal(r.result.segments[0].text, "Synthetic expected subject");
    assert.equal(r.usage.requests, 4);
    assert.deepEqual(
      f.calls.map(({ u }) => u.pathname),
      ["/x/web-interface/view", nav, signed, "/opaque-correct.json"],
    );
    const p = f.calls[2].u.searchParams;
    assert.deepEqual([...p.keys()].sort(), ["bvid", "cid", "w_rid", "wts"]);
    assert.equal(p.get("bvid"), bv);
    assert.equal(p.get("cid"), "7");
    const wts = Number(p.get("wts"));
    assert.ok(wts >= before && wts <= Math.floor(Date.now() / 1000));
    // Independent fixed-key vector, not the production signing implementation.
    const mix = "bbaabaababaababbababbabaaaababba";
    assert.equal(mix.length, 32);
    assert.equal(
      p.get("w_rid"),
      createHash("md5")
        .update(`bvid=${bv}&cid=7&wts=${wts}` + mix)
        .digest("hex"),
    );
    assert.equal(r.result.subtitleSource.signing, "wbi");
    assert.equal(r.result.subtitleSource.semanticVerification, "unverified");
    assert.deepEqual(r.result.subtitleSource.identityFields, [
      "bvid",
      "cid",
      "aid",
    ]);
    assert.equal(f.calls.at(-1).request.headers.Cookie, undefined);
    assert.equal(f.service.status().pause, null);
    assert.equal((await f.service.read(bv)).usage.requests, 0);
  });

test("legacy positive caches are bypassed without rewriting saved sources", async (t) => {
  const f = fixture(t);
  const old = {
    bvid: bv,
    cid: 7,
    page: 1,
    duration: 60,
    route: "A1",
    segments: [
      { start: 0, end: 58, text: "Synthetic unrelated subject", source: "A1" },
    ],
    coverage: { state: "partial" },
  };
  const saved = f.service.store.saveReading(old);
  const stored = f.service.store.reading(saved.id);
  for (const version of [1, 2])
    f.service.store.cachePut(
      `read-v${version}:${bv}:1:${digest(secret).slice(0, 16)}`,
      old,
    );
  const fresh = await f.service.read(bv);
  assert.equal(fresh.usage.requests, 4);
  assert.equal(fresh.result.segments[0].text, "Synthetic expected subject");
  assert.deepEqual(f.service.store.reading(saved.id), stored);
  assert.notEqual(fresh.result.id, saved.id);
  assert.equal((await f.service.read(bv)).usage.requests, 0);
});

test("one nav response supplies both A1 and A2 signatures", async (t) => {
  const f = fixture(t, { empty: true });
  assert.equal((await f.service.read(bv)).result.route, "A2");
  assert.equal(f.calls.filter(({ u }) => u.pathname === nav).length, 1);
  assert.equal(f.calls.length, 4);
  assert.ok(!f.calls.some(({ u }) => u.pathname === legacy));
});

for (const field of ["bvid", "cid", "aid"])
  test(`mismatched returned ${field} blocks CDN, fallback and cache`, async (t) => {
    const f = fixture(t, {
      responses: {
        [signed]: () =>
          json({
            code: 0,
            data: {
              bvid: bv,
              cid: 7,
              aid: 17,
              [field]: field === "bvid" ? "BVxxxxxxxxxx" : 999,
              subtitle: {
                subtitles: [
                  {
                    lan: "zh-CN",
                    subtitle_url: "https://aisubtitle.hdslb.com/foreign.json",
                  },
                ],
              },
            },
          }),
      },
    });
    await assert.rejects(
      f.service.read(bv),
      (e) => e.code === "SUBTITLE_SOURCE_MISMATCH",
    );
    assert.equal(f.calls.length, 3);
    assert.equal(
      f.service.store.db.prepare("SELECT count(*) AS n FROM cache").get().n,
      0,
    );
  });

test("a player envelope without identity fields never claims identity verification", async (t) => {
  const f = fixture(t, {
    responses: {
      [signed]: () =>
        json({
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                {
                  lan: "zh-CN",
                  subtitle_url:
                    "https://aisubtitle.hdslb.com/opaque-correct.json",
                },
              ],
            },
          },
        }),
    },
  });
  const r = await f.service.read(bv);
  assert.equal(r.result.route, "A1");
  assert.deepEqual(r.result.subtitleSource.identityFields, []);
  assert.equal(r.result.subtitleSource.semanticVerification, "unverified");
});

for (const path of [nav, signed])
  test(`HTTP 412 at ${path} stops without legacy fallback and persists`, async (t) => {
    const f = fixture(t, { responses: { [path]: () => json({}, 412) } });
    await assert.rejects(
      f.service.read(bv),
      (e) => e.code === "PLATFORM_PAUSED",
    );
    assert.equal(f.service.status().pause.reason, "HTTP_412");
    assert.ok(!f.calls.some(({ u }) => u.pathname === legacy));
    const before = f.calls.length;
    await assert.rejects(
      f.service.read(bv),
      (e) => e.code === "PERSISTENT_PAUSE",
    );
    assert.equal(f.calls.length, before);
  });

for (const scenario of ["credential", "player", "malformed", "challenge"])
  test(`logged-out nav exception stays narrow: ${scenario}`, async (t) => {
    const path = scenario === "player" ? signed : nav;
    const f = fixture(t, {
      anonymous: scenario !== "credential",
      responses: {
        [path]: () =>
          json({
            code: -101,
            data: {
              isLogin: false,
              wbi_img: scenario === "malformed" ? {} : wi,
              ...(scenario === "challenge"
                ? { v_voucher: "synthetic-challenge" }
                : {}),
            },
          }),
      },
    });
    await assert.rejects(
      f.service.read(bv),
      (e) =>
        e.code ===
        (scenario === "challenge" ? "PLATFORM_PAUSED" : "CREDENTIAL_EXPIRED"),
    );
    assert.ok(f.service.status().pause);
    assert.ok(!f.calls.some(({ u }) => u.pathname === legacy));
  });

test("malformed successful nav keys fail closed without legacy fallback", async (t) => {
  const f = fixture(t, {
    responses: {
      [nav]: () =>
        json({
          code: 0,
          data: {
            wbi_img: { img_url: "bad", sub_url: wi.sub_url },
          },
        }),
    },
  });
  await assert.rejects(f.service.read(bv), (e) => e.code === "WBI_UNAVAILABLE");
  assert.equal(f.calls.length, 2);
});

test("the extra nav request still obeys the configured hard request budget", async (t) => {
  const f = fixture(t, { limits: { requests: 3 } });
  await assert.rejects(f.service.read(bv), (e) => e.code === "REQUESTS_BUDGET");
  assert.equal(f.calls.length, 3);
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) AS n FROM cache").get().n,
    0,
  );
});

// AI subtitle files named for a video start with its aid and cid digits.
const longAid = 100000000000017;
const longCid = 10000000007;
const longView = () =>
  json({
    code: 0,
    data: {
      bvid: bv,
      aid: longAid,
      title: "Synthetic expected subject",
      owner: { mid: 1 },
      pages: [{ page: 1, cid: longCid, duration: 60 }],
    },
  });
const longPlayer =
  (...subtitles) =>
  () =>
    json({
      code: 0,
      data: { bvid: bv, aid: longAid, cid: longCid, subtitle: { subtitles } },
    });
const aiTrack = (name) => ({
  lan: "ai-zh",
  subtitle_url:
    "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/" +
    name +
    "?auth_key=synthetic",
});

test("an AI track named for another video blocks CDN, fallback and cache", async (t) => {
  const f = fixture(t, {
    responses: {
      "/x/web-interface/view": longView,
      // The envelope echoes the target IDs; only the track name is foreign.
      [signed]: longPlayer(
        aiTrack("100000000000099" + "10000000009" + "c".repeat(32)),
      ),
    },
  });
  await assert.rejects(
    f.service.read(bv),
    (e) => e.code === "SUBTITLE_SOURCE_MISMATCH",
  );
  assert.equal(f.calls.length, 3);
  assert.ok(!f.calls.some(({ u }) => u.hostname === "aisubtitle.hdslb.com"));
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) AS n FROM cache").get().n,
    0,
  );
});

test("an AI track named for this video is read and its binding recorded", async (t) => {
  const f = fixture(t, {
    responses: {
      "/x/web-interface/view": longView,
      [signed]: longPlayer(aiTrack(`${longAid}${longCid}correct`)),
    },
  });
  const r = await f.service.read(bv);
  assert.equal(r.result.route, "A1");
  assert.equal(r.result.segments[0].text, "Synthetic expected subject");
  assert.deepEqual(r.result.subtitleSource.identityFields, [
    "bvid",
    "cid",
    "aid",
    "subtitleTrack",
  ]);
  assert.equal(r.result.subtitleSource.semanticVerification, "unverified");
});

test("track names with fewer than 16 leading digits stay opaque", async (t) => {
  const f = fixture(t, {
    responses: {
      "/x/web-interface/view": longView,
      [signed]: longPlayer(aiTrack("123456789012345correct")),
    },
  });
  const r = await f.service.read(bv);
  assert.equal(r.result.route, "A1");
  assert.deepEqual(r.result.subtitleSource.identityFields, [
    "bvid",
    "cid",
    "aid",
  ]);
});

for (const [label, subtitles, route] of [
  [
    "is skipped for a readable track",
    [
      { lan: "zh-CN", subtitle_url: "" },
      {
        lan: "ai-zh",
        subtitle_url: "https://aisubtitle.hdslb.com/opaque-correct.json",
      },
    ],
    "A1",
  ],
  [
    "leaves A1 empty and unconfirmed",
    [{ lan: "ai-zh", subtitle_url: "" }],
    "A2",
  ],
])
  test(`a listed track without an address ${label}`, async (t) => {
    const f = fixture(t, {
      responses: {
        [signed]: () =>
          json({
            code: 0,
            data: { bvid: bv, aid: 17, cid: 7, subtitle: { subtitles } },
          }),
      },
    });
    const r = await f.service.read(bv);
    assert.equal(r.result.route, route);
    assert.equal(
      r.result.attempts[0].state,
      route === "A1" ? "text_available" : "empty_unconfirmed",
    );
  });
