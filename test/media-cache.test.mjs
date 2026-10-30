import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import { permitted } from "../lib/network.mjs";
import { apply } from "../index.js";

const bv = "BV0000000001";
const cdn = "https://synthetic.mcdn.bilivideo.cn:8082/synthetic.m4s";
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

function fixture(t, options = {}) {
  const root =
    options.root || mkdtempSync(join(tmpdir(), "humanism-media-cache-"));
  const calls = [];
  const credentialPath = join(root, "synthetic-credential.json");
  writeFileSync(credentialPath, '{"sessdata":"SYNTHETIC_MEDIA_COOKIE"}');
  const state = { subtitles: false };
  const service = new Service(
    {
      dataDir: root,
      ...(options.credential ? { credentialPath } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
    },
    {
      fetcher: async (u, request) => {
        const path = new URL(u).pathname;
        calls.push({ path, request });
        if (path === "/x/web-interface/view")
          return json({
            code: 0,
            data: {
              title: "Synthetic source",
              owner: { name: "Synthetic author", mid: 1 },
              pages: [{ page: 1, cid: 7, duration: 60 }],
            },
          });
        if (path === "/x/player/v2")
          return json({
            code: 0,
            data: {
              subtitle: {
                subtitles: state.subtitles
                  ? [
                      {
                        lan: "zh-CN",
                        subtitle_url:
                          "https://aisubtitle.hdslb.com/synthetic.json",
                      },
                    ]
                  : [],
              },
            },
          });
        if (path === "/synthetic.json")
          return json({
            body: [{ from: 0, to: 10, content: "Synthetic current subtitle" }],
          });
        if (path === "/x/player/playurl")
          return json({
            code: 0,
            data: {
              dash: {
                audio: options.audioTracks || [
                  { bandwidth: 100, baseUrl: options.mediaURL || cdn },
                ],
              },
            },
          });
        if (path === "/synthetic.m4s")
          return (
            options.mediaResponse?.() || new Response("SYNTHETIC_AUDIO_BYTES")
          );
        if (path === "/synthetic-backup.m4s")
          return (
            options.backupResponse?.() || new Response("SYNTHETIC_BACKUP_BYTES")
          );
        assert.fail("Unexpected synthetic endpoint");
      },
    },
  );
  t.after(() => service.close());
  return { root, service, calls, state };
}

function seed(service, overrides = {}) {
  return service.store.saveReading({
    bvid: bv,
    page: 1,
    cid: 7,
    duration: 60,
    route: "none",
    segments: [],
    coverage: { state: "no_subtitles", speech: "unknown" },
    ...overrides,
  });
}

const asr = (text = "Synthetic local ASR, not independently verified") => ({
  route: "A3",
  duration: 60,
  segments: [{ start: 0, end: 60, text }],
});

test("media allowlist accepts only the documented CDN host and port pairs", () => {
  for (const u of [
    cdn,
    "https://synthetic.mcdn.bilivideo.cn/synthetic.m4s",
    "https://synthetic.bilivideo.com/synthetic.m4s",
  ])
    assert.equal(permitted(u, "media").protocol, "https:");
  for (const u of [
    "http://synthetic.mcdn.bilivideo.cn:8082/synthetic.m4s",
    "https://synthetic.mcdn.bilivideo.cn:80/synthetic.m4s",
    "https://synthetic.mcdn.bilivideo.cn:4483/synthetic.m4s",
    "https://synthetic.bilivideo.com:8082/synthetic.m4s",
    "https://synthetic.bilivideo.cn:8082/synthetic.m4s",
    "https://synthetic.mcdn.bilivideo.cn.evil.test:8082/synthetic.m4s",
    "https://evil-mcdn.bilivideo.cn:8082/synthetic.m4s",
    "https://user:password@synthetic.mcdn.bilivideo.cn:8082/synthetic.m4s",
    "https://127.0.0.1:8082/synthetic.m4s",
  ])
    assert.throws(
      () => permitted(u, "media"),
      (e) => e.code === "URL_DENIED",
    );
  assert.throws(
    () => permitted("https://api.bilibili.com:8082/x/player/playurl"),
    (e) => e.code === "URL_DENIED",
  );
  assert.throws(
    () =>
      permitted("https://aisubtitle.hdslb.com:8082/synthetic.json", "subtitle"),
    (e) => e.code === "URL_DENIED",
  );
});

test("audio downloads a playurl-provided MCDN resource without forwarding credentials", async (t) => {
  const { service, calls } = fixture(t, { credential: true });
  const result = await service.audio(seed(service).id);
  assert.equal(
    readFileSync(result.result.path, "utf8"),
    "SYNTHETIC_AUDIO_BYTES",
  );
  assert.equal(result.usage.requests, 2);
  assert.equal(
    calls[0].request.headers.Cookie,
    "SESSDATA=SYNTHETIC_MEDIA_COOKIE",
  );
  assert.equal(calls[1].request.headers.Cookie, undefined);
  assert.ok(
    calls.every(
      (c) => c.request.method === "GET" && c.request.redirect === "manual",
    ),
  );
  assert.ok(!JSON.stringify(result).includes(cdn));
});

test("audio falls back to an allowlisted backup CDN when the primary is off-list", async (t) => {
  // 实测 B 站把最低码率音频的 baseUrl 换到 PCDN 域名（不在允许清单内），
  // 而同一 track 的 backupUrl 仍指向 bilivideo.com。抽帧早已沿同清晰度备选回退
  // （#7），音频路径此前没有。这里锁定：主地址被拒后继续尝试允许清单内的备选，
  // 且凭据仍只发给 API、不发往 CDN。
  const { service, calls } = fixture(t, {
    credential: true,
    audioTracks: [
      {
        bandwidth: 100,
        baseUrl: "https://synthetic.pcdn.invalid/synthetic.m4s",
        backupUrl: [
          "https://synthetic-backup.bilivideo.com/synthetic-backup.m4s",
        ],
      },
    ],
  });
  const result = await service.audio(seed(service).id);
  assert.equal(
    readFileSync(result.result.path, "utf8"),
    "SYNTHETIC_BACKUP_BYTES",
  );
  // 被拒的主地址在 permitted() 阶段返回，不消耗请求额度；只计 playurl 与备选。
  assert.equal(result.usage.requests, 2);
  assert.equal(
    calls[0].request.headers.Cookie,
    "SESSDATA=SYNTHETIC_MEDIA_COOKIE",
  );
  assert.equal(calls[1].request.headers.Cookie, undefined);
  assert.ok(
    calls.every(
      (c) => c.request.method === "GET" && c.request.redirect === "manual",
    ),
  );
  assert.ok(!JSON.stringify(result).includes("pcdn.invalid"));
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_BACKUP_BYTES"));
});

test("audio keeps the off-list rejection when no allowlisted alternative exists", async (t) => {
  const { service, calls } = fixture(t, {
    audioTracks: [
      {
        bandwidth: 100,
        baseUrl: "https://synthetic.pcdn.invalid/synthetic.m4s",
        backupUrl: ["https://synthetic.pcdn2.invalid/synthetic.m4s"],
      },
    ],
  });
  await assert.rejects(
    service.audio(seed(service).id),
    (e) => e.code === "URL_DENIED",
  );
  // 两个地址都在 permitted() 阶段被拒，未到达传输层；失败不猜测其他目标。
  assert.equal(calls.length, 1);
});

test("audio alternative retry stays inside the shared request budget", async (t) => {
  const { service, calls } = fixture(t, {
    limits: { requests: 1 },
    audioTracks: [
      {
        bandwidth: 100,
        baseUrl: "https://synthetic.pcdn.invalid/synthetic.m4s",
        backupUrl: [
          "https://synthetic-backup.bilivideo.com/synthetic-backup.m4s",
        ],
      },
    ],
  });
  await assert.rejects(
    service.audio(seed(service).id),
    (e) => e.code === "REQUESTS_BUDGET",
  );
  // playurl 用尽唯一额度；备选尝试在传输层前被预算拦下。
  assert.equal(calls.length, 1);
});

test("audio still rejects an off-list playurl resource before CDN dispatch", async (t) => {
  const { service, calls } = fixture(t, {
    mediaURL: "https://127.0.0.1:8082/synthetic.m4s",
  });
  await assert.rejects(
    service.audio(seed(service).id),
    (e) => e.code === "URL_DENIED",
  );
  assert.equal(calls.length, 1);
});

for (const status of [403, 412, 429]) {
  test(`audio backup never continues after HTTP ${status} risk pause`, async (t) => {
    const { service, calls } = fixture(t, {
      audioTracks: [
        {
          bandwidth: 100,
          baseUrl: cdn,
          backupUrl: [
            "https://synthetic-backup.bilivideo.com/synthetic-backup.m4s",
          ],
        },
      ],
      mediaResponse: () => new Response(null, { status }),
    });
    await assert.rejects(
      service.audio(seed(service).id),
      (e) => e.code === "PLATFORM_PAUSED",
    );
    assert.equal(calls.length, 2);
    assert.ok(!calls.some((c) => c.path === "/synthetic-backup.m4s"));
    const before = calls.length;
    await assert.rejects(
      service.audio(seed(service).id),
      (e) => e.code === "PERSISTENT_PAUSE",
    );
    assert.equal(calls.length, before);
  });
}
test("audio backup does not bypass the media byte cap", async (t) => {
  const { service, calls } = fixture(t, {
    audioTracks: [
      {
        bandwidth: 100,
        baseUrl: cdn,
        backupUrl: [
          "https://synthetic-backup.bilivideo.com/synthetic-backup.m4s",
        ],
      },
    ],
    mediaResponse: () =>
      new Response("synthetic", {
        headers: { "content-length": String(32 * 1024 * 1024 + 1) },
      }),
  });
  await assert.rejects(
    service.audio(seed(service).id),
    (e) => e.code === "RESPONSE_TOO_LARGE",
  );
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((c) => c.path === "/synthetic-backup.m4s"));
});

test("MCDN media keeps redirect, byte and request-budget limits", async (t) => {
  for (const [options, code, count] of [
    [
      {
        mediaResponse: () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.test/" },
          }),
      },
      "HTTP_FAILED",
      2,
    ],
    [
      {
        mediaResponse: () =>
          new Response("small", {
            headers: { "content-length": String(32 * 1024 * 1024 + 1) },
          }),
      },
      "RESPONSE_TOO_LARGE",
      2,
    ],
    [{ limits: { requests: 1 } }, "REQUESTS_BUDGET", 1],
  ]) {
    const { service, calls } = fixture(t, options);
    await assert.rejects(
      service.audio(seed(service).id),
      (e) => e.code === code,
    );
    assert.equal(calls.length, count);
  }
});

test("an unconfirmed empty read reuses imported ASR across restart without losing provenance or old IDs", async (t) => {
  const { root, service, calls } = fixture(t);
  const empty = (await service.read(bv)).result;
  assert.equal(empty.route, "none");
  const imported = (await service.importLocal(empty.id, asr())).result;
  assert.notEqual(imported.id, empty.id);
  const rows = service.store.db
    .prepare("SELECT COUNT(*) AS count FROM readings")
    .get().count;
  calls.length = 0;
  const read = await service.read(bv);
  assert.equal(read.result.route, "A3");
  assert.equal(read.result.id, imported.id);
  assert.equal(read.result.segments.length, 1);
  assert.equal(read.result.coverage.state, "asr_partial");
  assert.match(read.result.localEvidence, /not independently verified/);
  assert.equal(read.result.reusedLocalSource, true);
  assert.equal(read.result.networkSource.route, "none");
  assert.equal(read.result.networkSource.cached, false);
  assert.equal(read.usage.requests, 2);
  assert.equal(calls.length, 2);
  assert.equal(service.store.reading(empty.id).segments.length, 0);
  assert.equal(
    service.store.db.prepare("SELECT COUNT(*) AS count FROM readings").get()
      .count,
    rows,
  );
  const { service: restarted } = fixture(t, { root });
  assert.equal((await restarted.read(bv)).result.id, imported.id);
});

test("local ASR selection matches BV, part, CID and duration and does not replace speech with frame text", async (t) => {
  const { service } = fixture(t);
  const empty = (await service.read(bv)).result;
  for (const difference of [
    { bvid: "BVxxxxxxxxxx" },
    { page: 2 },
    { cid: 8 },
    { duration: 59 },
    { route: "frame" },
  ])
    seed(service, { ...asr(), ...difference });
  assert.equal((await service.read(bv)).result.route, "none");
  const first = (
    await service.importLocal(empty.id, asr("Synthetic first import"))
  ).result;
  const latest = (
    await service.importLocal(empty.id, asr("Synthetic later correction"))
  ).result;
  assert.notEqual(first.id, latest.id);
  assert.equal((await service.read(bv)).result.id, latest.id);
});

test("freshly fetched empty results can reuse local ASR while current subtitles keep priority", async (t) => {
  const { service, state } = fixture(t);
  const empty = (await service.read(bv)).result;
  const imported = (await service.importLocal(empty.id, asr())).result;
  const expire = () =>
    service.store.db
      .prepare("UPDATE cache SET created=?")
      .run(Date.now() - 7 * 3600_000);
  expire();
  const freshEmpty = await service.read(bv);
  assert.equal(freshEmpty.result.id, imported.id);
  assert.equal(freshEmpty.result.networkSource.cached, false);
  assert.equal(freshEmpty.usage.requests, 2);
  state.subtitles = true;
  expire();
  const freshSubtitle = await service.read(bv);
  assert.equal(freshSubtitle.result.route, "A1");
  assert.notEqual(freshSubtitle.result.id, imported.id);
  assert.equal(freshSubtitle.result.reusedLocalSource, undefined);
});

test("available local ASR does not bypass a persisted risk pause", async (t) => {
  const { service, calls } = fixture(t);
  const empty = (await service.read(bv)).result;
  await service.importLocal(empty.id, asr());
  service.store.pause("SYNTHETIC_RISK");
  calls.length = 0;
  await assert.rejects(service.read(bv), (e) => e.code === "PERSISTENT_PAUSE");
  assert.equal(calls.length, 0);
});

test("registered DSH read, import and source tools preserve the reused ASR ID and pagination", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "humanism-tool-cache-"));
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    const path = new URL(url).pathname;
    if (path === "/x/web-interface/view")
      return json({
        code: 0,
        data: { pages: [{ page: 1, cid: 7, duration: 60 }] },
      });
    if (path === "/x/player/v2")
      return json({ code: 0, data: { subtitle: { subtitles: [] } } });
    assert.fail("Unexpected synthetic tool endpoint");
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const tools = new Map();
  let dispose;
  apply(
    {
      tools: { register: (tool) => tools.set(tool.name, tool) },
      effect: (setup) => {
        dispose = setup();
      },
    },
    { dataDir: root, enableDailyFetching: false },
  );
  t.after(() => dispose());
  const call = async (name, args) =>
    JSON.parse(await tools.get("bili_humanism_" + name).execute(args, {}));
  const empty = await call("read", { video: bv });
  const imported = await call("import", {
    readingId: empty.result.id,
    json: JSON.stringify({
      route: "A3",
      duration: 60,
      segments: [
        { start: 0, end: 30, text: "Synthetic first section ".repeat(600) },
        { start: 30, end: 60, text: "Synthetic second section ".repeat(600) },
      ],
    }),
  });
  const reused = await call("read", { video: bv });
  assert.equal(imported.error, undefined);
  assert.equal(reused.result.id, imported.result.id);
  assert.equal(reused.result.route, "A3");
  assert.equal(reused.result.segment_count, 2);
  assert.equal(reused.result.segments.length, 1);
  assert.equal(reused.result.next_offset, 1);
  assert.equal(reused.result.reusedLocalSource, true);
  assert.equal(reused.usage.requests, 2);
  assert.equal(requests, 4);
  const source = await call("source", {
    readingId: reused.result.id,
    offset: reused.result.next_offset,
  });
  assert.equal(source.segment_count, 2);
  assert.equal(source.next_offset, null);
  assert.ok(source.segments[0].text.startsWith("Synthetic second section"));
});
