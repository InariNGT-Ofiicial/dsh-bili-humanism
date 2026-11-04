import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  DANMAKU_ITEM_LIMIT,
  fitEntries,
  parseDanmakuXml,
  peaks,
  scanDanmakuXml,
  summarize,
} from "../lib/danmaku.mjs";
import { Budget } from "../lib/budget.mjs";
import { Network, RESPONSE_BYTE_LIMITS, permitted } from "../lib/network.mjs";
import { Service } from "../lib/service.mjs";
import { Store } from "../lib/store.mjs";

const d = (t, text, { mode = 1, pool = 0, id = 9, weight } = {}) =>
  `<d p="${t},${mode},25,16777215,1600000000,${pool},abcd1234,${id}${weight === undefined ? "" : "," + weight}">${text}</d>`;
const doc = (...items) =>
  `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>synthetic</chatserver>${items.join("")}</i>`;
const texts = (xml, duration = 100) =>
  parseDanmakuXml(xml, duration).map((item) => item.text);
const item = (t, text, weight = 0) => ({ t, text, weight });
const repeat = (n, t, text = "same") =>
  Array.from({ length: n }, () => item(t, text));
const dmURL = "https://api.bilibili.com/x/v1/dm/list.so?oid=7";

test("parser reads the p fields and sorts by time", () => {
  assert.deepEqual(
    parseDanmakuXml(
      doc(
        d("30.50000", "late", { id: 22, weight: 7 }),
        d(2, "early", { id: 11 }),
      ),
      100,
    ),
    [
      { t: 2, text: "early", weight: 0, id: "11" },
      { t: 30.5, text: "late", weight: 7, id: "22" },
    ],
  );
  assert.equal(
    parseDanmakuXml(doc(d(1, "x", { weight: "bad" })), 100)[0].weight,
    0,
  );
  assert.deepEqual(
    texts(`<i><d class="c" p='1,1'>any attribute order</d></i>`),
    ["any attribute order"],
  );
});

test("parser decodes entities once and cleans text after decoding", () => {
  assert.deepEqual(
    [
      "&lt;b&gt; &quot;q&quot; &apos;a&apos; &amp;",
      "&amp;lt; stays literal",
      "&#20320;&#x597D;&#128512;",
      "kept&#1114112;&#xD800;&#99999999999;",
      "&unknown; stays",
      "bell&#7;gone\u0001",
      "line&#10;break",
      "  wide \t\n  gaps  ",
    ].map((text, i) => texts(doc(d(i + 1, text)))[0]),
    [
      `<b> "q" 'a' &`,
      "&lt; stays literal",
      "你好😀",
      "kept",
      "&unknown; stays",
      "bellgone",
      "line break",
      "wide gaps",
    ],
  );
  assert.deepEqual(texts(doc(d(1, "&#7;"), d(2, "  "), d(3, ""))), []);
});

test("parser keeps modes 1-6, drops pool 2, malformed items and times out of range", () => {
  assert.deepEqual(
    texts(
      doc(
        ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((mode) =>
          d(mode + 1, "mode" + mode, { mode }),
        ),
      ),
    ),
    ["mode1", "mode2", "mode3", "mode4", "mode5", "mode6"],
  );
  assert.deepEqual(
    texts(doc(...[0, 1, 2].map((pool) => d(1, "pool" + pool, { pool })))),
    ["pool0", "pool1"],
  );
  assert.deepEqual(
    texts(
      doc(
        `<d>no attribute</d>`,
        `<d p="">empty</d>`,
        `<d p=",1">no time, which Number() would read as 0</d>`,
        `<d p="abc,1">bad time</d>`,
        `<d p="Infinity,1">infinite time</d>`,
        `<d p="1">no mode</d>`,
        `<data p="1,1">other element</data>`,
      ),
    ),
    [],
  );
  assert.deepEqual(
    parseDanmakuXml(
      doc(
        d(-1, "before"),
        d(0, "start"),
        d(101, "duration plus one"),
        d(101.01, "after"),
      ),
      100,
    ).map((row) => row.t),
    [0, 101],
  );
});

test("parser drops items over 80 characters whole, counted in code points after decoding", () => {
  const smile = "\u{1f600}";
  assert.deepEqual(
    texts(
      doc(
        d(1, "x".repeat(80)),
        d(2, "x".repeat(81)),
        d(3, smile.repeat(80)),
        d(4, smile.repeat(81)),
        d(5, "&amp;".repeat(80)),
        d(6, "&amp;".repeat(81)),
      ),
    ).map((text) => [...text].length),
    [80, 80, 80],
  );
});

test("parser caps at 6000 by weight, then restores time order", () => {
  const low = Array.from({ length: DANMAKU_ITEM_LIMIT }, (_, i) =>
    d(50 + i / 1000, "low" + i, { weight: 1 }),
  );
  const zero = Array.from({ length: 50 }, (_, i) =>
    d(i, "zero" + i, { weight: 0 }),
  );
  const high = Array.from({ length: 5 }, (_, i) =>
    d(90 - i, "high" + i, { weight: 11 }),
  );
  const { total, items } = scanDanmakuXml(doc(...low, ...zero, ...high), 100);
  assert.equal(total, DANMAKU_ITEM_LIMIT + 55);
  assert.equal(items.length, DANMAKU_ITEM_LIMIT);
  assert.equal(items.filter((row) => row.weight === 11).length, 5);
  assert.equal(items.filter((row) => row.weight === 0).length, 0);
  assert.ok(items.every((row, i) => i === 0 || items[i - 1].t <= row.t));
});

test("scan counts every element before filtering; bad input is explicit", () => {
  assert.deepEqual(
    scanDanmakuXml(doc(d(1, "kept"), d(2, "gone", { pool: 2 })), 100).total,
    2,
  );
  assert.equal(scanDanmakuXml("<i></i>", 100).total, 0);
  assert.throws(
    () => parseDanmakuXml(null, 100),
    (e) => e.code === "DANMAKU_INVALID",
  );
  for (const duration of [undefined, NaN, 0, -1, Infinity])
    assert.throws(
      () => parseDanmakuXml("<i></i>", duration),
      (e) => e.code === "INVALID_DURATION",
    );
});

test("summarize groups a closed window, ordered by count, weight, then text", () => {
  const rows = [
    item(1, "b"),
    item(1, "a"),
    item(2, "light", 1),
    item(2, "light", 1),
    item(3, "heavy", 1),
    item(3, "heavy", 9),
    item(4, "most"),
    item(4, "most"),
    item(4, "most"),
    item(5, "edge"),
    item(5.01, "outside"),
  ];
  assert.deepEqual(summarize(rows, 1, 5), [
    "most ×3",
    "heavy ×2",
    "light ×2",
    "a",
    "b",
    "edge",
  ]);
  assert.deepEqual(summarize(rows, 1, 5, 2), ["most ×3", "heavy ×2"]);
  assert.deepEqual(summarize(rows, 5, 5), ["edge"]);
  assert.deepEqual(summarize(rows, 6, 9), []);
});

test("summarize counts everything in the window before applying the limit", () => {
  const rows = [
    ...Array.from({ length: 100 }, (_, i) => item(i / 100, "unique" + i, 5)),
    ...repeat(3, 2, "late"),
  ];
  assert.deepEqual(summarize(rows, 0, 3, 1), ["late ×3"]);
  assert.equal(summarize(rows, 0, 3).length, 16);
});

test("peaks choose bins of at least three and twice the median", () => {
  const quiet = Array.from({ length: 9 }, (_, i) => item(i * 40 + 15, "q" + i));
  assert.deepEqual(peaks([...quiet, ...repeat(2, 205)], 400), []);
  const found = peaks([...quiet, ...repeat(3, 205)], 400);
  assert.deepEqual(found, [{ at: 205, n: 3, lines: ["same ×3"] }]);
  const bins = (...sizes) =>
    sizes.flatMap((size, i) => repeat(size, i * 100 + 1, "bin" + i));
  assert.deepEqual(peaks(bins(4, 4, 4, 7), 500), []);
  assert.deepEqual(
    peaks(bins(4, 4, 4, 8), 500).map((peak) => peak.n),
    [8],
  );
  // An even number of non-empty bins takes the mean of the two middle counts.
  assert.deepEqual(
    peaks(bins(2, 2, 4, 6), 500).map((peak) => peak.n),
    [6],
  );
  // A lone or even spread of activity is no peak.
  assert.deepEqual(peaks(repeat(9, 5), 500), []);
  assert.deepEqual(peaks(bins(5, 5, 5, 5), 500), []);
  assert.deepEqual(peaks([], 500), []);
});

test("peaks keep the strongest bins, spaced by reported time and limited in number", () => {
  const close = [
    ...repeat(1, 5),
    ...repeat(1, 45),
    ...repeat(1, 85),
    ...repeat(1, 125),
    ...repeat(1, 165),
    ...repeat(5, 200, "weaker"),
    ...repeat(9, 215, "stronger"),
    ...repeat(4, 300, "far"),
  ];
  assert.deepEqual(
    peaks(close, 400).map(({ at, n }) => [at, n]),
    [
      [215, 9],
      [300, 4],
    ],
  );
  // Bin starts 30 s apart can still report closer times; both are not returned.
  const edges = [
    ...repeat(1, 100),
    ...repeat(1, 140),
    ...repeat(1, 180),
    ...repeat(8, 9, "first"),
    ...repeat(4, 30, "second"),
  ];
  assert.deepEqual(
    peaks(edges, 400).map(({ at }) => at),
    [9],
  );
  const many = Array.from({ length: 8 }, (_, i) =>
    repeat(i + 10, i * 60 + 1, "peak" + i),
  ).flat();
  const quiet = Array.from({ length: 12 }, (_, i) =>
    item(i * 10 + 485, "q" + i),
  );
  const six = peaks([...many, ...quiet], 600);
  assert.deepEqual(
    six.map(({ n }) => n),
    [12, 13, 14, 15, 16, 17],
  );
  assert.deepEqual(
    peaks([...many, ...quiet], 600, { count: 2 }).map(({ n }) => n),
    [16, 17],
  );
  assert.ok(six.every((peak, i) => i === 0 || peak.at > six[i - 1].at));
  assert.deepEqual(
    peaks(close, 400, { minGap: 0 }).map(({ at }) => at),
    [200, 215, 300],
  );
});

test("peak time is the mean of its bin, and bins do not share items", () => {
  const rows = [
    ...repeat(1, 100),
    ...repeat(1, 200),
    ...repeat(1, 300),
    item(10, "in"),
    item(11, "in"),
    item(12.25, "in"),
    item(20, "next bin"),
  ];
  assert.deepEqual(peaks(rows, 400), [{ at: 11.1, n: 3, lines: ["in ×3"] }]);
});

test("peak lines group whole texts first, then fit 40 characters with the count intact", () => {
  const shared = "s".repeat(45);
  const smile = "\u{1f600}";
  const rows = [
    ...repeat(1, 100),
    ...repeat(1, 200),
    ...repeat(1, 300),
    ...repeat(1, 400),
    ...repeat(3, 5, shared + "aaa"),
    ...repeat(2, 5, shared + "bbb"),
    item(5, smile.repeat(50)),
    item(5, "x".repeat(40)),
    item(5, "short"),
  ];
  const [peak] = peaks(rows, 500);
  assert.equal(peak.n, 8);
  assert.deepEqual(peak.lines.slice(0, 2), [
    "s".repeat(36) + "… ×3",
    "s".repeat(36) + "… ×2",
  ]);
  assert.ok(peak.lines.every((line) => [...line].length <= 40));
  assert.ok(peak.lines.includes("short"));
  assert.ok(peak.lines.includes("x".repeat(40)));
  assert.ok(peak.lines.includes(smile.repeat(39) + "…"));
  assert.deepEqual(peaks(rows, 500, { lines: 1 })[0].lines, [
    "s".repeat(36) + "… ×3",
  ]);
  assert.equal(peaks(rows, 500)[0].lines.length, 5);
  const crowded = [
    ...repeat(1, 100),
    ...repeat(1, 200),
    ...repeat(1, 300),
    ...repeat(1, 400),
    ...Array.from({ length: 20 }, (_, i) => item(5, "line" + i)),
  ];
  assert.equal(peaks(crowded, 500)[0].lines.length, 8);
});

test("the second allowed past the duration stays in the final bin and inside the source", () => {
  const rows = [
    ...repeat(1, 5),
    ...repeat(1, 25),
    ...repeat(3, 100.6),
    item(102, "beyond the allowed range"),
  ];
  assert.deepEqual(peaks(rows, 100), [{ at: 100, n: 3, lines: ["same ×3"] }]);
  assert.throws(
    () => peaks([], 0),
    (e) => e.code === "INVALID_DURATION",
  );
  assert.throws(
    () => peaks([], 100, { binSeconds: 0 }),
    (e) => e.code === "INVALID_DURATION",
  );
});

function networkFixture(t, fetcher, { requests = 12, credentials } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "humanism-dm-net-")));
  const store = new Store(dir),
    id = store.start();
  t.after(() => store.close());
  const budget = new Budget(store, id, { requests, wallMs: 90000 });
  let credentialPath;
  if (credentials) {
    credentialPath = join(dir, "credentials.json");
    writeFileSync(credentialPath, JSON.stringify(credentials));
  }
  return {
    store,
    budget,
    network: new Network(store, budget, { fetcher, credentialPath }),
  };
}

test("danmaku kind permits exactly the digits-only list endpoint and no other kind reaches it", () => {
  assert.equal(permitted(dmURL, "danmaku").search, "?oid=7");
  assert.equal(
    permitted("https://api.bilibili.com:443/x/v1/dm/list.so?oid=7", "danmaku")
      .hostname,
    "api.bilibili.com",
  );
  for (const raw of [
    "https://api.bilibili.com/x/v1/dm/list.so",
    "https://api.bilibili.com/x/v1/dm/list.so?oid=",
    "https://api.bilibili.com/x/v1/dm/list.so?oid=abc",
    "https://api.bilibili.com/x/v1/dm/list.so?oid=-7",
    "https://api.bilibili.com/x/v1/dm/list.so?oid=%37",
    "https://api.bilibili.com/x/v1/dm/list.so?oid=7&x=1",
    "https://api.bilibili.com/x/v1/dm/list.so?x=1&oid=7",
    "https://api.bilibili.com/x/v1/dm/list.so?oid=7#fragment",
    "https://api.bilibili.com/x/v1/dm/list.so/?oid=7",
    "https://api.bilibili.com/x/v2/dm/list.so?oid=7",
    "https://api.bilibili.com/x/web-interface/view?oid=7",
    "https://comment.bilibili.com/x/v1/dm/list.so?oid=7",
    "https://api.bilibili.com:8443/x/v1/dm/list.so?oid=7",
    "https://user:pass@api.bilibili.com/x/v1/dm/list.so?oid=7",
    "http://api.bilibili.com/x/v1/dm/list.so?oid=7",
  ])
    assert.throws(
      () => permitted(raw, "danmaku"),
      (e) => e.code === "URL_DENIED",
      raw,
    );
  for (const kind of ["api", "subtitle", "media"])
    assert.throws(
      () => permitted(dmURL, kind),
      (e) => e.code === "URL_DENIED",
    );
});

test("danmaku transport returns a string from plain or raw-deflate bodies, without a Cookie", async (t) => {
  const xml = doc(d(1, "你好"));
  const calls = [];
  const bodies = [
    Buffer.from(xml),
    deflateRawSync(xml),
    // Stored blocks keep "<i>" visible in compressed bytes, as chance can.
    deflateRawSync(xml, { level: 0 }),
  ];
  const f = networkFixture(
    t,
    async (_url, request) => {
      calls.push(request);
      return new Response(bodies.shift());
    },
    { credentials: { sessdata: "synthetic-session", buvid3: "synthetic" } },
  );
  for (let i = 0; i < 3; i++)
    assert.equal(await f.network.get(dmURL, "danmaku"), xml);
  assert.ok(
    calls.every(
      (request) =>
        request.headers.Cookie === undefined && request.redirect === "manual",
    ),
  );
  assert.equal(f.budget.requests, 3);
});

test("danmaku bodies that are neither XML nor valid deflate of XML raise DANMAKU_INVALID", async (t) => {
  for (const body of [
    "",
    "<html>not the document</html>",
    '{"code":0}',
    deflateRawSync("deflated but no document"),
    deflateRawSync("<i>" + "0".repeat(16 * 1024 * 1024)),
  ]) {
    const f = networkFixture(t, async () => new Response(body));
    await assert.rejects(
      f.network.get(dmURL, "danmaku"),
      (e) => e.code === "DANMAKU_INVALID" && e.message === "DANMAKU_INVALID",
    );
    assert.equal(f.store.getControl("pause"), null);
  }
});

test("danmaku bodies obey the JSON byte cap and existing risk handling", async (t) => {
  const large = Buffer.alloc(RESPONSE_BYTE_LIMITS.json + 1, "<");
  const streamed = networkFixture(t, async () => new Response(large));
  await assert.rejects(
    streamed.network.get(dmURL, "danmaku"),
    (e) => e.code === "RESPONSE_TOO_LARGE" && /^Danmaku /.test(e.message),
  );
  const declared = networkFixture(
    t,
    async () =>
      new Response("<i></i>", {
        headers: { "content-length": String(large.length) },
      }),
  );
  await assert.rejects(
    declared.network.get(dmURL, "danmaku"),
    (e) => e.code === "RESPONSE_TOO_LARGE",
  );
  for (const status of [401, 403, 412, 429]) {
    let calls = 0;
    const f = networkFixture(t, async () => {
      calls++;
      return new Response("", { status });
    });
    await assert.rejects(
      f.network.get(dmURL, "danmaku"),
      (e) => e.code === "PLATFORM_PAUSED",
    );
    assert.equal(calls, 1);
    assert.equal(f.store.getControl("pause").reason, "HTTP_" + status);
  }
  for (const status of [302, 500]) {
    const f = networkFixture(t, async () => new Response("", { status }));
    await assert.rejects(
      f.network.get(dmURL, "danmaku"),
      (e) => e.code === "HTTP_FAILED",
    );
    assert.equal(f.store.getControl("pause"), null);
  }
});

function fixture(t, respond, { config = {}, cid = 7, duration = 400 } = {}) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "humanism-dm-")));
  const calls = [];
  const fetcher = async (url, request) => {
    calls.push({ url: new URL(url), request });
    return respond(new URL(url), request);
  };
  const service = new Service({ dataDir, ...config }, { fetcher });
  t.after(() => service.close());
  const reading = service.store.saveReading({
    bvid: "BV0000000001",
    page: 1,
    cid,
    duration,
    route: "none",
    segments: [],
    coverage: { state: "no_subtitles", speech: "unknown" },
  });
  return { dataDir, service, reading, calls, fetcher };
}
const document_ = doc(
  ...[100, 150, 250, 350].map((t) => d(t, "quiet" + t)),
  ...[201, 202, 203, 204, 205].map((t) => d(t, "哈哈", { weight: 3 })),
  d(202, "dropped pool", { pool: 2 }),
  d(203, "advanced", { mode: 7 }),
);

test("danmaku fetches once, caches compact rows and answers the same across restarts", async (t) => {
  const f = fixture(t, async () => new Response(document_));
  const first = await f.service.danmaku(f.reading.id);
  assert.deepEqual(first, {
    status: "ready",
    total: 11,
    kept: 9,
    top: ["哈哈 ×5", "quiet100", "quiet150", "quiet250", "quiet350"],
    peaks: [{ at: 203, n: 5, lines: ["哈哈 ×5"] }],
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url.href, dmURL);
  assert.equal(f.calls[0].request.headers.Cookie, undefined);
  const { total, rows } = f.service.store.getControl("danmaku:" + f.reading.id);
  assert.equal(total, 11);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows[0], [100, "quiet100", 0]);
  assert.deepEqual(rows[1], [150, "quiet150", 0]);
  assert.deepEqual(rows[2], [201, "哈哈", 3]);
  assert.deepEqual(await f.service.danmaku(f.reading.id), first);
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.service.store.status().tasks.filter((row) => row.status === "completed")
      .length,
    1,
  );
  const restarted = new Service(
    { dataDir: f.dataDir },
    { fetcher: () => assert.fail("Cached danmaku must not refetch") },
  );
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.danmaku(f.reading.id), first);
});

test("danmaku cache never exceeds 6000 rows", async (t) => {
  const f = fixture(
    t,
    async () =>
      new Response(
        doc(
          ...Array.from({ length: DANMAKU_ITEM_LIMIT + 200 }, (_, i) =>
            d(i / 100, "line" + i, { weight: i % 3 }),
          ),
        ),
      ),
  );
  const result = await f.service.danmaku(f.reading.id);
  assert.equal(result.total, DANMAKU_ITEM_LIMIT + 200);
  assert.equal(result.kept, DANMAKU_ITEM_LIMIT);
  assert.equal(
    f.service.store.getControl("danmaku:" + f.reading.id).rows.length,
    DANMAKU_ITEM_LIMIT,
  );
  assert.equal(result.top.length, 16);
});

test("an answered empty document is a cached result, not a failure", async (t) => {
  const f = fixture(t, async () => new Response("<i></i>"));
  const expected = { status: "ready", total: 0, kept: 0, top: [], peaks: [] };
  assert.deepEqual(await f.service.danmaku(f.reading.id), expected);
  assert.deepEqual(await f.service.danmaku(f.reading.id), expected);
  assert.equal(f.calls.length, 1);
});

test("failures become explicit unavailable results, stay uncached and leave a failed task", async (t) => {
  for (const [respond, error, requests] of [
    [() => new Response("", { status: 500 }), "HTTP_FAILED", 1],
    [() => new Response("<html></html>"), "DANMAKU_INVALID", 1],
    [
      () => new Response(Buffer.alloc(RESPONSE_BYTE_LIMITS.json + 1, "<")),
      "RESPONSE_TOO_LARGE",
      1,
    ],
    [
      () => {
        throw new Error("PRIVATE synthetic reset");
      },
      "NETWORK_FAILED",
      3,
    ],
  ]) {
    let fail = true;
    const f = fixture(t, async (...args) =>
      fail ? respond(...args) : new Response(document_),
    );
    assert.deepEqual(await f.service.danmaku(f.reading.id), {
      status: "unavailable",
      error,
    });
    assert.equal(f.calls.length, requests);
    assert.equal(f.service.store.getControl("danmaku:" + f.reading.id), null);
    assert.equal(f.service.store.getControl("pause"), null);
    const [task] = f.service.store.status().tasks;
    assert.equal(task.status, "failed");
    assert.equal(task.error, error);
    assert.deepEqual(f.service.danmakuAround(f.reading.id, 203), []);
    fail = false;
    assert.equal((await f.service.danmaku(f.reading.id)).status, "ready");
    assert.equal(f.calls.length, requests + 1);
  }
});

test("budget, wall, busy, missing and malformed sources do not throw", async (t) => {
  const never = async () => assert.fail("Unexpected danmaku request");
  const unavailable = (error) => ({ status: "unavailable", error });
  const missing = fixture(t, never);
  assert.deepEqual(
    await missing.service.danmaku("missing-reading"),
    unavailable("READING_NOT_FOUND"),
  );
  const budget = fixture(t, never, { config: { limits: { requests: 0 } } });
  assert.deepEqual(
    await budget.service.danmaku(budget.reading.id),
    unavailable("REQUESTS_BUDGET"),
  );
  const wall = fixture(t, never, { config: { limits: { wallMs: 0 } } });
  assert.deepEqual(
    await wall.service.danmaku(wall.reading.id),
    unavailable("WALL_BUDGET"),
  );
  const noCid = fixture(t, never, { cid: "7&x=1" });
  assert.deepEqual(
    await noCid.service.danmaku(noCid.reading.id),
    unavailable("URL_DENIED"),
  );
  const busy = fixture(t, never);
  const running = busy.service.store.start();
  assert.deepEqual(
    await busy.service.danmaku(busy.reading.id),
    unavailable("TASK_BUSY"),
  );
  busy.service.store.finish(running, "completed");
});

test("risk responses, persistent pauses and invalid credentials propagate", async (t) => {
  const risky = fixture(t, async () => new Response("", { status: 412 }));
  await assert.rejects(
    risky.service.danmaku(risky.reading.id),
    (e) => e.code === "PLATFORM_PAUSED",
  );
  assert.equal(risky.service.store.getControl("pause").reason, "HTTP_412");
  await assert.rejects(
    risky.service.danmaku(risky.reading.id),
    (e) => e.code === "PERSISTENT_PAUSE",
  );
  assert.equal(risky.calls.length, 1);
  assert.equal(
    risky.service.store.getControl("danmaku:" + risky.reading.id),
    null,
  );

  const dir = mkdtempSync(join(tmpdir(), "humanism-dm-credential-"));
  const credentialPath = join(dir, "credential.json");
  writeFileSync(credentialPath, "{}");
  const invalid = fixture(t, async () => assert.fail("Unexpected request"), {
    config: { credentialPath },
  });
  await assert.rejects(
    invalid.service.danmaku(invalid.reading.id),
    (e) => e.code === "CREDENTIAL_INVALID",
  );
  assert.ok(invalid.service.store.getControl("pause"));
});

test("cancellation propagates before, during and at service close", async (t) => {
  const never = async () => assert.fail("Unexpected danmaku request");
  const before = fixture(t, never);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    before.service.danmaku(before.reading.id, aborted.signal),
    (e) => e.code === "CANCELLED",
  );
  const failIfAborted = (request) => {
    assert.equal(request.signal.aborted, true);
    throw new Error("aborted");
  };
  const during = new AbortController();
  const mid = fixture(t, async (_url, request) => {
    during.abort();
    return failIfAborted(request);
  });
  await assert.rejects(
    mid.service.danmaku(mid.reading.id, during.signal),
    (e) => e.code === "CANCELLED",
  );
  assert.equal(mid.service.store.getControl("danmaku:" + mid.reading.id), null);
  const closing = fixture(t, async (_url, request) => {
    closing.service.close();
    return failIfAborted(request);
  });
  await assert.rejects(
    closing.service.danmaku(closing.reading.id),
    (e) => e.code === "CANCELLED",
  );
});

test("a cached answer needs no network, so a later pause does not hide it", async (t) => {
  const f = fixture(t, async () => new Response(document_));
  const first = await f.service.danmaku(f.reading.id);
  f.service.store.pause("SYNTHETIC_RISK");
  assert.deepEqual(await f.service.danmaku(f.reading.id), first);
  assert.equal(f.calls.length, 1);
});

test("danmakuAround reads only the cache", async (t) => {
  const f = fixture(t, async () => new Response(document_));
  assert.deepEqual(f.service.danmakuAround(f.reading.id, 203), []);
  assert.equal(f.calls.length, 0);
  await f.service.danmaku(f.reading.id);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.service.danmakuAround(f.reading.id, 203), ["哈哈 ×5"]);
  assert.deepEqual(f.service.danmakuAround(f.reading.id, 196), ["哈哈"]);
  assert.deepEqual(f.service.danmakuAround(f.reading.id, 200, 0), []);
  assert.deepEqual(f.service.danmakuAround(f.reading.id, 203, 60), [
    "哈哈 ×5",
    "quiet150",
    "quiet250",
  ]);
  assert.deepEqual(f.service.danmakuAround(f.reading.id, 203, 100, 2), [
    "哈哈 ×5",
    "quiet150",
  ]);
  assert.deepEqual(f.service.danmakuAround("missing-reading", 203), []);
  assert.equal(f.calls.length, 1);
});

const riskBodies = [
  ['{"code":-412,"message":"synthetic"}', "API_-412"],
  ['{"code":-352,"message":"synthetic"}', "API_-352"],
  ['{"code":-101,"message":"synthetic"}', "API_-101"],
  ['{"code":-111,"message":"synthetic"}', "API_-111"],
  ['{"code":-403,"message":"synthetic"}', "API_-403"],
  ['{"code":-509,"message":"synthetic"}', "API_-509"],
  ['{"code":0,"data":{"v_voucher":"synthetic"}}', "API_CHALLENGE"],
  ['{"code":-1,"message":"验证码"}', "API_CHALLENGE"],
  ["<html><body>验证码</body></html>", "NON_JSON_CHALLENGE"],
  ["<html><i>验证码</i></html>", "NON_JSON_CHALLENGE"],
  ["<html>captcha</html>", "NON_JSON_CHALLENGE"],
];

test("a challenge answering 200 in place of the document pauses, plain or deflated", async (t) => {
  for (const [text, reason] of riskBodies)
    for (const body of [text, deflateRawSync(text)]) {
      const f = networkFixture(t, async () => new Response(body));
      await assert.rejects(
        f.network.get(dmURL, "danmaku"),
        (e) => e.code === "PLATFORM_PAUSED",
        text,
      );
      assert.equal(f.store.getControl("pause").reason, reason);
    }
});

test("a challenge past the bytes the page check reads, or an ordinary refusal, is only invalid", async (t) => {
  for (const text of [
    '{"code":-404,"message":"synthetic"}',
    "x".repeat(8192) + "验证码",
    "[1,2]",
    "null",
  ]) {
    const f = networkFixture(t, async () => new Response(text));
    await assert.rejects(
      f.network.get(dmURL, "danmaku"),
      (e) => e.code === "DANMAKU_INVALID",
      text.slice(0, 40),
    );
    assert.equal(f.store.getControl("pause"), null);
  }
});

test("a 200 challenge stops the next call before any request and caches nothing", async (t) => {
  for (const [text, reason] of riskBodies) {
    const f = fixture(t, async () => new Response(deflateRawSync(text)));
    await assert.rejects(f.service.danmaku(f.reading.id), {
      code: "PLATFORM_PAUSED",
    });
    assert.equal(f.service.store.getControl("pause").reason, reason);
    assert.equal(f.service.store.getControl("danmaku:" + f.reading.id), null);
    await assert.rejects(f.service.danmaku(f.reading.id), {
      code: "PERSISTENT_PAUSE",
    });
    assert.equal(f.calls.length, 1);
  }
});

test("only the shape of the document counts as an answer, inflated or plain", async (t) => {
  for (const xml of [
    "<i></i>",
    "\uFEFF<i></i>",
    " \r\n\t<i></i>",
    '<?xml version="1.0" encoding="UTF-8"?><i></i>',
    '\uFEFF  <?xml version="1.0"?>\n  <i></i>',
    doc(d(1, "验证码")),
    doc(d(1, '{"code":-412}')),
  ])
    for (const body of [xml, deflateRawSync(xml)]) {
      const f = networkFixture(t, async () => new Response(body));
      assert.equal(await f.network.get(dmURL, "danmaku"), xml);
      assert.equal(f.store.getControl("pause"), null);
    }
  for (const text of [
    "<html><i>x</i></html>",
    "junk<i></i>",
    "<?xml?>junk<i></i>",
    "<i",
    "<I></I>",
    "<d><i></i></d>",
  ])
    for (const body of [text, deflateRawSync(text)]) {
      const f = fixture(t, async () => new Response(body));
      assert.deepEqual(await f.service.danmaku(f.reading.id), {
        status: "unavailable",
        error: "DANMAKU_INVALID",
      });
      assert.equal(f.service.store.getControl("danmaku:" + f.reading.id), null);
      assert.equal(f.service.store.getControl("pause"), null);
    }
});

test("a stream inflating past the limit never falls back to its bytes", async (t) => {
  // A stored block keeps these bytes readable in the stream. As text they would read as
  // a document by substring, or as a challenge that pauses every later read.
  const stored = Buffer.concat([
    Buffer.from([0, 10, 0, 0xf5, 0xff]),
    Buffer.from("<i>captcha"),
  ]);
  const bomb = Buffer.concat([
    stored,
    deflateRawSync(Buffer.alloc(17 * 1024 * 1024, "0")),
  ]);
  assert.ok(bomb.includes("<i>captcha"));
  const f = fixture(t, async () => new Response(bomb));
  assert.deepEqual(await f.service.danmaku(f.reading.id), {
    status: "unavailable",
    error: "DANMAKU_INVALID",
  });
  assert.equal(f.service.store.getControl("danmaku:" + f.reading.id), null);
  assert.equal(f.service.store.getControl("pause"), null);
});

test("one viewer's text cannot read as a computed count or as the gap between entries", () => {
  assert.deepEqual(
    summarize([item(1, "太真实了 ×9999")], -Infinity, Infinity),
    ["太真实了 x9999"],
  );
  assert.deepEqual(
    summarize(repeat(2, 1, "太真实了 ×9"), -Infinity, Infinity),
    ["太真实了 x9 ×2"],
  );
  assert.deepEqual(
    summarize(
      [
        item(1, "甲 / 乙 ×3 / 丙"),
        item(1, "/ 开头"),
        item(1, "结尾 /"),
        item(1, "/"),
      ],
      -Infinity,
      Infinity,
    ).sort(),
    ["／", "／ 开头", "甲 ／ 乙 x3 ／ 丙", "结尾 ／"].sort(),
  );
  // Ordinary uses keep their characters, and identical stored text still counts together.
  assert.deepEqual(
    summarize(
      [
        item(1, "1/2"),
        item(1, "a/ b"),
        item(1, "a /b"),
        item(1, "3×4"),
        item(1, "×"),
      ],
      -Infinity,
      Infinity,
    ).sort(),
    ["1/2", "a/ b", "a /b", "3×4", "×"].sort(),
  );
  const [peak] = peaks(
    [
      ...repeat(5, 5, "太真实了 ×9999 / 真的"),
      item(20, "甲"),
      item(30, "乙"),
      item(40, "丙"),
    ],
    100,
  );
  assert.deepEqual(peak.lines, ["太真实了 x9999 ／ 真的 ×5"]);
});

test("fitEntries keeps entries whole, then shortens one and never its count", () => {
  assert.equal(fitEntries([], 80), "");
  assert.equal(fitEntries(["同句 ×2", "另一句"], 80), "同句 ×2 / 另一句");
  // Exactly the limit stays whole.
  assert.equal(fitEntries(["a".repeat(80)], 80), "a".repeat(80));
  assert.equal(
    fitEntries(["a".repeat(77) + " ×12"], 80),
    "a".repeat(75) + "… ×12",
  );
  assert.equal(
    fitEntries(["a".repeat(60) + " ×123", "b".repeat(20) + " ×12"], 80),
    "a".repeat(60) + " ×123 / " + "b".repeat(7) + "… ×12",
  );
  // No room for one character, an ellipsis and the count: the entry goes whole, and
  // nothing shorter slips in after it.
  assert.equal(
    fitEntries(["a".repeat(70), "b".repeat(9) + " ×123", "c"], 80),
    "a".repeat(70) + " / " + "b…" + " ×123",
  );
  assert.equal(
    fitEntries(["a".repeat(72), "b".repeat(9) + " ×123", "c"], 80),
    "a".repeat(72),
  );
  // Characters, not UTF-16 units.
  assert.equal(fitEntries(["😀".repeat(81)], 80), "😀".repeat(79) + "…");
});
