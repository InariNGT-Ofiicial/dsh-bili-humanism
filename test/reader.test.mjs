import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import { digest } from "../lib/store.mjs";

const bv = "BV0000000001";
const secret = "SYNTHETIC_READER_COOKIE";
const player = "/x/player/v2";
const conclusion = "/x/web-interface/view/conclusion/get";
const subtitle = "/synthetic-reader.json";
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "humanism-reader-"));
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
      fetcher: async (u, request) => {
        const path = new URL(u).pathname;
        calls.push({ path, request });
        if (options.responses?.[path]) return options.responses[path]();
        if (path === "/x/web-interface/view")
          return response({
            code: 0,
            data: {
              title: "Synthetic reader fixture",
              owner: { name: "Synthetic author", mid: 1 },
              pages: [{ page: 1, cid: 7, duration: options.duration ?? 60 }],
            },
          });
        if (path === player)
          return response({
            code: 0,
            data: {
              subtitle: {
                subtitles: options.noTracks
                  ? []
                  : [
                      {
                        lan: "zh-CN",
                        subtitle_url: "https://aisubtitle.hdslb.com" + subtitle,
                      },
                    ],
              },
            },
          });
        if (path === subtitle)
          return response({
            body:
              options.trackBody ??
              (options.emptyTrack
                ? []
                : [
                    {
                      from: 0,
                      to: 58,
                      content: "Synthetic detailed subtitle with later evidence",
                    },
                  ]),
          });
        if (path === "/x/web-interface/nav")
          return response({
            code: 0,
            data: {
              wbi_img: {
                img_url: "https://i0.hdslb.com/" + "a".repeat(32) + ".png",
                sub_url: "https://i0.hdslb.com/" + "b".repeat(32) + ".png",
              },
            },
          });
        if (path === conclusion)
          return response({
            code: 0,
            data: {
              model_result: {
                summary: "Synthetic summary is not a transcript",
                outline: [{ title: "Synthetic outline", timestamp: 0 }],
                ...(options.summaryOnly
                  ? {}
                  : {
                      subtitle: [
                        {
                          part_subtitle: [
                            {
                              start_timestamp: 0,
                              end_timestamp: 10,
                              content: "Synthetic A2 fragment",
                            },
                          ],
                        },
                      ],
                    }),
              },
            },
          });
        assert.fail("Unexpected synthetic endpoint");
      },
    },
  );
  t.after(() => service.close());
  return { service, calls, root, credentialPath };
}

test("available subtitle track takes precedence over A2 fragments and avoids optional summary traffic", async (t) => {
  const { service, calls } = fixture(t);
  const read = await service.read(bv);
  assert.equal(read.result.route, "A1");
  assert.equal(read.result.segments[0].end, 58);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/x/web-interface/view", player, subtitle],
  );
  assert.equal(read.usage.requests, 3);
  assert.ok(calls.every((c) => c.request.method === "GET"));
  assert.equal(calls.at(-1).request.headers.Cookie, undefined);
});

test("adding a provided device cookie invalidates the session-only empty cache without bypassing a pause", async (t) => {
  const f = fixture(t, { noTracks: true, summaryOnly: true });
  assert.equal((await f.service.read(bv)).result.route, "none");
  assert.equal((await f.service.read(bv)).usage.requests, 0);
  writeFileSync(
    f.credentialPath,
    JSON.stringify({ sessdata: secret, buvid3: "synthetic-existing-device" }),
  );
  const refreshed = await f.service.read(bv);
  assert.ok(refreshed.usage.requests > 0);
  assert.equal(refreshed.result.cached, false);
  assert.equal(
    f.calls.at(-1).request.headers.Cookie,
    `SESSDATA=${secret}; buvid3=synthetic-existing-device`,
  );
  assert.equal((await f.service.read(bv)).usage.requests, 0);
  f.service.store.pause("SYNTHETIC_RISK");
  writeFileSync(
    f.credentialPath,
    JSON.stringify({
      sessdata: secret,
      buvid3: "synthetic-other-existing-device",
    }),
  );
  const before = f.calls.length;
  await assert.rejects(
    f.service.read(bv),
    (error) => error.code === "PERSISTENT_PAUSE",
  );
  assert.equal(f.calls.length, before);
});

for (const mode of ["noTracks", "emptyTrack", "unavailableTrack"]) {
  test(`A2 remains a fallback after ${mode}`, async (t) => {
    const { service, calls } = fixture(t, {
      [mode]: true,
      ...(mode === "unavailableTrack"
        ? { responses: { [player]: () => response({ code: -404 }) } }
        : {}),
    });
    const read = await service.read(bv);
    assert.equal(read.result.route, "A2");
    assert.equal(read.result.segments[0].source, "A2");
    assert.equal(read.result.coverage.state, "partial");
    assert.equal(read.result.attempts[0].route, "A1");
    assert.equal(
      read.result.attempts[0].state,
      mode === "unavailableTrack" ? "read_failed" : "no_subtitles",
    );
    assert.ok(
      calls.findIndex((c) => c.path === player) <
        calls.findIndex((c) => c.path === conclusion),
    );
    assert.equal(read.usage.requests, mode === "emptyTrack" ? 5 : 4);
  });
}

test("summary and outline alone never become subtitle segments", async (t) => {
  const { service, calls } = fixture(t, { noTracks: true, summaryOnly: true });
  const read = await service.read(bv);
  assert.equal(read.result.route, "none");
  assert.deepEqual(read.result.segments, []);
  assert.equal(read.result.coverage.state, "no_subtitles");
  assert.equal(read.result.coverage.speech, "unknown");
  assert.equal(calls.at(-1).path, conclusion);
});

test("anonymous subtitle failure is reported and does not request A2", async (t) => {
  const { service, calls } = fixture(t, {
    anonymous: true,
    responses: { [player]: () => response({ code: -404 }) },
  });
  const read = await service.read(bv);
  assert.equal(read.result.coverage.state, "read_failed");
  assert.ok(
    read.result.attempts.some(
      (a) => a.route === "A2" && a.state === "requires_local_credential",
    ),
  );
  assert.equal(calls.length, 2);
});

test("risk on the subtitle request stops A2 and persists the pause", async (t) => {
  const { service, calls, root } = fixture(t, {
    responses: { [player]: () => response({}, 412) },
  });
  await assert.rejects(service.read(bv), (e) => e.code === "PLATFORM_PAUSED");
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/x/web-interface/view", player],
  );
  const restarted = new Service({ dataDir: root });
  t.after(() => restarted.close());
  await assert.rejects(
    restarted.read(bv),
    (e) => e.code === "PERSISTENT_PAUSE",
  );
});

test("subtitle-first reading preserves the hard request budget without A2 bypass", async (t) => {
  const { service, calls } = fixture(t, { limits: { requests: 1 } });
  await assert.rejects(service.read(bv), (e) => e.code === "REQUESTS_BUDGET");
  assert.equal(calls.length, 1);
  assert.equal(service.status().tasks[0].requests, 1);
});

test("old A2 cache is bypassed while stored readings and new cache remain usable", async (t) => {
  const { service, calls, root, credentialPath } = fixture(t);
  const old = {
    bvid: bv,
    page: 1,
    cid: 7,
    duration: 60,
    route: "A2",
    segments: [
      { start: 0, end: 10, text: "Synthetic old fragment", source: "A2" },
    ],
    coverage: { state: "partial" },
  };
  const oldId = service.store.saveReading(old).id;
  service.store.cachePut(`read-v1:${bv}:1:${digest(secret).slice(0, 16)}`, old);
  const first = await service.read(bv);
  assert.equal(first.result.route, "A1");
  assert.notEqual(first.result.id, oldId);
  assert.equal(calls.length, 3);
  assert.equal(service.store.reading(oldId).route, "A2");

  const restarted = new Service(
    { dataDir: root, credentialPath },
    { fetcher: () => assert.fail("New cache must survive restart") },
  );
  t.after(() => restarted.close());
  const second = await restarted.read(bv);
  assert.equal(second.result.id, first.result.id);
  assert.equal(second.result.cached, true);
  assert.equal(second.usage.requests, 0);
});

test("subtitle lines past the part duration are clamped instead of failing the whole track", async (t) => {
  // The metadata duration can understate the real length and generated tracks
  // pad their tail: here 43 of 133 synthetic lines start beyond the +5s
  // tolerance of the 60s part. A track that is mostly placeable must keep its
  // readable text instead of failing the whole reading.
  const trackBody = Array.from({ length: 133 }, (_, i) =>
    i < 90
      ? { from: i * 0.6, to: i * 0.6 + 0.6, content: `Synthetic line ${i}` }
      : {
          from: 65 + (i - 90) * 0.12,
          to: 65 + (i - 90) * 0.12 + 0.12,
          content: `Synthetic line ${i}`,
        },
  );
  const { service } = fixture(t, { trackBody });
  const read = await service.read(bv);
  assert.equal(read.result.route, "A1");
  assert.equal(read.result.coverage.state, "partial");
  assert.equal(read.result.segments.length, 133);
  for (const s of read.result.segments) {
    assert.ok(s.start >= 0 && s.start <= 60, `start ${s.start} escaped the part`);
    assert.ok(s.end >= s.start && s.end <= 60, `end ${s.end} escaped the part`);
  }
  assert.equal(read.result.segments.filter((s) => s.start === 60).length, 43);
  assert.ok(read.result.coverage.timed_fraction <= 1);
});

test("a track whose every line starts past the part is still rejected", async (t) => {
  const { service } = fixture(t, {
    trackBody: [
      { from: 500, to: 600, content: "Synthetic wrong-file line" },
      { from: 700, to: 800, content: "Synthetic wrong-file line" },
    ],
  });
  await assert.rejects(
    service.read(bv),
    (error) => error.code === "INVALID_TIMESTAMP",
  );
});

test("a track that runs past twice the part is not clamped into that part", async (t) => {
  // Observed shapes: an 11 s part carrying a lone 27 s ad line, and the same
  // part carrying a 1202 s track that belongs to some other video. Clamping
  // either one would report unrelated text as this part's captions, so the
  // mismatch stays a loud failure instead of becoming a plausible transcript.
  for (const trackBody of [
    [{ from: 0.397, to: 27.425, content: "Synthetic ad line" }],
    Array.from({ length: 12 }, (_, i) => ({
      from: i * 100,
      to: i * 100 + 100,
      content: `Synthetic foreign line ${i}`,
    })),
  ]) {
    const { service } = fixture(t, { duration: 11, trackBody });
    await assert.rejects(
      service.read(bv),
      (error) => error.code === "INVALID_TIMESTAMP",
    );
  }
});

test("unreadable subtitle timestamps still fail the reading", async (t) => {
  for (const from of ["not-a-number", -1]) {
    const { service } = fixture(t, {
      trackBody: [{ from, to: 1, content: "Synthetic unreadable line" }],
    });
    await assert.rejects(
      service.read(bv),
      (error) => error.code === "INVALID_TIMESTAMP",
    );
  }
});
