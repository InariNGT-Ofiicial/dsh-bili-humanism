import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import { permitted } from "../lib/network.mjs";

const video = "BV0000000001";
const player = "/x/player/wbi/v2";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "humanism-player-endpoint-"));
  const credentialPath = join(root, "synthetic-credential.json");
  writeFileSync(
    credentialPath,
    JSON.stringify({
      sessdata: "SYNTHETIC_PLAYER_COOKIE",
      buvid3: "synthetic-existing-device",
    }),
  );
  const calls = [];
  const config = {
    dataDir: root,
    ...(options.anonymous ? {} : { credentialPath }),
    ...(options.limits ? { limits: options.limits } : {}),
  };
  const service = new Service(config, {
    fetcher: async (url, request) => {
      const u = new URL(url);
      calls.push({ url: u, request });
      if (u.pathname === "/x/web-interface/view")
        return json({
          code: 0,
          data: {
            title: "Synthetic player source",
            owner: { mid: 1 },
            pages: [{ page: 1, cid: 7, duration: 60 }],
          },
        });
      if (u.pathname === player)
        return (
          options.playerResponse?.() ||
          json({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  {
                    lan: "ai-zh",
                    subtitle_url:
                      "https://aisubtitle.hdslb.com/synthetic-player.json",
                  },
                ],
              },
            },
          })
        );
      if (u.pathname === "/synthetic-player.json")
        return json({
          body:
            options.segments ||
            Array.from({ length: 7 }, (_, i) => ({
              from: i * 8 + 0.25,
              to: i * 8 + 7.5,
              content: "Synthetic timed subtitle " + i,
            })),
        });
      if (u.pathname === "/x/web-interface/nav")
        return json({
          code: 0,
          data: {
            wbi_img: {
              img_url: "https://i0.hdslb.com/" + "a".repeat(32) + ".png",
              sub_url: "https://i0.hdslb.com/" + "b".repeat(32) + ".png",
            },
          },
        });
      if (u.pathname === "/x/web-interface/view/conclusion/get") {
        assert.match(u.searchParams.get("w_rid"), /^[a-f0-9]{32}$/);
        assert.match(u.searchParams.get("wts"), /^\d+$/);
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
      }
      assert.fail("Unexpected synthetic endpoint");
    },
  });
  t.after(() => service.close());
  return { root, service, calls };
}

for (const anonymous of [false, true])
  test(`A1 uses the signed WBI player endpoint (${anonymous ? "guest" : "credential"})`, async (t) => {
    const { service, calls } = fixture(t, { anonymous });
    const reading = await service.read(video);
    assert.equal(reading.result.route, "A1");
    assert.equal(reading.result.segments.length, 7);
    assert.equal(reading.result.segments[0].start, 0.25);
    assert.equal(reading.result.segments[6].end, 55.5);
    assert.equal(reading.usage.requests, 4);
    assert.deepEqual(
      calls.map((c) => c.url.pathname),
      [
        "/x/web-interface/view",
        "/x/web-interface/nav",
        player,
        "/synthetic-player.json",
      ],
    );
    assert.equal(calls[2].url.searchParams.get("bvid"), video);
    assert.equal(calls[2].url.searchParams.get("cid"), "7");
    assert.ok(
      calls.every(
        (c) => c.request.method === "GET" && c.request.redirect === "manual",
      ),
    );
    assert.equal(
      calls[2].request.headers.Cookie,
      anonymous
        ? undefined
        : "SESSDATA=SYNTHETIC_PLAYER_COOKIE; buvid3=synthetic-existing-device",
    );
    assert.equal(calls[3].request.headers.Cookie, undefined);
    assert.equal(service.status().pause, null);
    assert.equal((await service.read(video)).usage.requests, 0);
  });

test("the added player capability is an exact read-only HTTPS path", () => {
  assert.equal(
    permitted("https://api.bilibili.com/x/player/wbi/v2?bvid=" + video)
      .pathname,
    player,
  );
  for (const url of [
    "http://api.bilibili.com/x/player/wbi/v2",
    "https://api.bilibili.com:8082/x/player/wbi/v2",
    "https://api.bilibili.com.evil.test/x/player/wbi/v2",
    "https://user@api.bilibili.com/x/player/wbi/v2",
    "https://api.bilibili.com/x/player/wbi/v2/extra",
    "https://api.bilibili.com/x/v2/reply/add",
  ])
    assert.throws(
      () => permitted(url),
      (e) => e.code === "URL_DENIED",
    );
});

test("412 at the corrected endpoint stops immediately and survives restart without fallback", async (t) => {
  const { service, root, calls } = fixture(t, {
    playerResponse: () => json({}, 412),
  });
  await assert.rejects(
    service.read(video),
    (e) => e.code === "PLATFORM_PAUSED",
  );
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    ["/x/web-interface/view", "/x/web-interface/nav", player],
  );
  assert.equal(service.status().pause.reason, "HTTP_412");
  const restarted = new Service(
    { dataDir: root },
    { fetcher: () => assert.fail("Persistent pause must block all requests") },
  );
  t.after(() => restarted.close());
  await assert.rejects(
    restarted.read(video),
    (e) => e.code === "PERSISTENT_PAUSE",
  );
  assert.equal(restarted.status().pause.reason, "HTTP_412");
});

test("ordinary A1 unavailability keeps the signed A2 fallback", async (t) => {
  const { service, calls } = fixture(t, {
    playerResponse: () => json({ code: -404 }),
  });
  const reading = await service.read(video);
  assert.equal(reading.result.route, "A2");
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    [
      "/x/web-interface/view",
      "/x/web-interface/nav",
      player,
      "/x/web-interface/view/conclusion/get",
    ],
  );
});

test("corrected A1 still enforces shared request budgets and timestamp validation", async (t) => {
  const limited = fixture(t, { limits: { requests: 2 } });
  await assert.rejects(
    limited.service.read(video),
    (e) => e.code === "REQUESTS_BUDGET",
  );
  assert.equal(limited.calls.length, 2);
  const invalid = fixture(t, {
    segments: [{ from: 500, to: 600, content: "Synthetic invalid timestamp" }],
  });
  await assert.rejects(
    invalid.service.read(video),
    (e) => e.code === "INVALID_TIMESTAMP",
  );
});
