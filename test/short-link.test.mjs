import { wbiNav } from "./fixtures/wbi.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "../lib/budget.mjs";
import { bvid, shortLink } from "../lib/reader.mjs";
import { Network, permitted } from "../lib/network.mjs";
import { Service } from "../lib/service.mjs";
import { Store } from "../lib/store.mjs";
import { safeError } from "../lib/errors.mjs";

const bv = "BV0000000001";
const short = "https://b23.tv/AbC123";
const target = `https://www.bilibili.com/video/${bv}/`;
const json = (body) => new Response(JSON.stringify(body));
const moved = (location, status = 302) =>
  new Response(null, { status, headers: location ? { location } : {} });

test("short link input accepts only the exact forms on both hosts", () => {
  for (const [input, expected] of [
    [short, short],
    ["b23.tv/AbC123", short],
    ["  b23.tv/AbC123  ", short],
    ["B23.TV/AbC123", short],
    ["https://bili2233.cn/AbC123", "https://bili2233.cn/AbC123"],
    ["bili2233.cn/AbC123", "https://bili2233.cn/AbC123"],
    ["b23.tv/" + "a".repeat(16), "https://b23.tv/" + "a".repeat(16)],
  ])
    assert.equal(shortLink(input), expected);
  for (const input of [
    null,
    undefined,
    7,
    bv,
    target,
    "b23.tv/",
    "b23.tv",
    "b23.tv/" + "a".repeat(17),
    "b23.tv/a-b",
    "b23.tv/a/b",
    "b23.tv/a/",
    "b23.tv/a?x=1",
    "b23.tv/a#x",
    "b23.tv:443/a",
    "http://b23.tv/a",
    "//b23.tv/a",
    "https://user@b23.tv/a",
    "https://b23.tv:8443/a",
    "https://b23.tv.synthetic.test/a",
    "https://synthetic.test/b23.tv/a",
    "www.b23.tv/a",
    "foo b23.tv/a",
  ])
    assert.equal(shortLink(input), null, String(input));
  // Writer targets and other strict callers still take BV ids only.
  assert.throws(() => bvid(short), { code: "INVALID_VIDEO" });
});

test("the shortlink kind reaches only short link hosts, and no other kind reaches them", () => {
  for (const raw of [short, "https://bili2233.cn/AbC123"])
    assert.equal(permitted(raw, "shortlink").protocol, "https:");
  for (const raw of [
    "http://b23.tv/AbC123",
    "https://b23.tv/",
    "https://b23.tv/a/b",
    "https://b23.tv/a-b",
    "https://b23.tv/" + "a".repeat(17),
    "https://b23.tv/AbC123?x=1",
    "https://b23.tv/AbC123#x",
    "https://b23.tv:8443/AbC123",
    "https://user:pass@b23.tv/AbC123",
    "https://www.b23.tv/AbC123",
    "https://api.bilibili.com/AbC123",
    "https://www.bilibili.com/AbC123",
  ])
    assert.throws(
      () => permitted(raw, "shortlink"),
      { code: "URL_DENIED" },
      raw,
    );
  for (const kind of ["api", "subtitle", "media", "danmaku", "other"])
    assert.throws(() => permitted(short, kind), { code: "URL_DENIED" });
});

function networkFixture(
  t,
  fetcher,
  { requests = 12, signal, credentials } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "humanism-short-net-")));
  const store = new Store(dir),
    id = store.start();
  t.after(() => store.close());
  const budget = new Budget(store, id, { requests, wallMs: 90000 }, signal);
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

test("resolution is one manual GET without a Cookie, spends budget and never follows", async (t) => {
  for (const status of [301, 302, 307, 308]) {
    const calls = [];
    const f = networkFixture(
      t,
      async (url, request) => {
        calls.push({ url: String(url), request });
        return moved(target, status);
      },
      { credentials: { sessdata: "synthetic-session", buvid3: "synthetic" } },
    );
    assert.deepEqual(await f.network.resolveShortLink(short), {
      bvid: bv,
      page: undefined,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, short);
    assert.equal(calls[0].request.method, "GET");
    assert.equal(calls[0].request.redirect, "manual");
    assert.equal(calls[0].request.headers.Cookie, undefined);
    assert.equal(f.budget.requests, 1);
  }
});

test("only https video addresses on www or m yield a BV id, with a numeric p", async (t) => {
  for (const [location, page] of [
    [target, undefined],
    [`https://www.bilibili.com/video/${bv}`, undefined],
    [`https://m.bilibili.com/video/${bv}`, undefined],
    [`https://www.bilibili.com:443/video/${bv}`, undefined],
    [`${target}?p=3`, 3],
    [`${target}?share_source=copy&p=3&vd_source=synthetic`, 3],
    [`${target}?p=abc`, undefined],
    [`${target}?p=1e3`, undefined],
    [`${target}?p=`, undefined],
  ]) {
    const f = networkFixture(t, async () => moved(location));
    assert.deepEqual(
      await f.network.resolveShortLink(short),
      { bvid: bv, page },
      location,
    );
  }
  for (const location of [
    null,
    "",
    `/video/${bv}`,
    `//www.bilibili.com/video/${bv}`,
    `http://www.bilibili.com/video/${bv}`,
    `https://bilibili.com/video/${bv}`,
    `https://space.bilibili.com/video/${bv}`,
    `https://www.bilibili.com.synthetic.test/video/${bv}`,
    `https://synthetic.test/video/${bv}`,
    `https://user:pass@www.bilibili.com/video/${bv}`,
    `https://www.bilibili.com@synthetic.test/video/${bv}`,
    `https://www.bilibili.com:8443/video/${bv}`,
    `https://www.bilibili.com/video/${bv}/extra`,
    `https://www.bilibili.com/video/${bv}0`,
    `https://www.bilibili.com/video/av7`,
    `https://www.bilibili.com/bangumi/play/${bv}`,
    `https://www.bilibili.com/?to=/video/${bv}`,
    "not a url PRIVATE_SIGNED_ADDRESS",
  ]) {
    let calls = 0;
    const f = networkFixture(t, async () => {
      calls++;
      return moved(location);
    });
    await assert.rejects(
      f.network.resolveShortLink(short),
      (error) => {
        assert.deepEqual(safeError(error), {
          error: "INVALID_VIDEO",
          message: "INVALID_VIDEO",
        });
        return true;
      },
      String(location),
    );
    assert.equal(calls, 1);
  }
});

test("a response other than the four redirects is INVALID_VIDEO; risk statuses still pause", async (t) => {
  for (const status of [200, 300, 303, 304, 404, 500]) {
    const f = networkFixture(
      t,
      async () =>
        new Response(status === 304 ? null : `{"code":0}`, {
          status,
          headers: { location: target },
        }),
    );
    await assert.rejects(f.network.resolveShortLink(short), {
      code: "INVALID_VIDEO",
    });
    assert.equal(f.store.getControl("pause"), null);
  }
  for (const status of [401, 403, 412, 429]) {
    const f = networkFixture(t, async () => new Response("", { status }));
    await assert.rejects(f.network.resolveShortLink(short), {
      code: "PLATFORM_PAUSED",
    });
    assert.equal(f.store.getControl("pause").reason, "HTTP_" + status);
  }
});

test("resolution makes one attempt and stops at budget, cancellation and pause", async (t) => {
  let calls = 0;
  const failing = networkFixture(t, async () => {
    calls++;
    throw new Error("PRIVATE synthetic reset");
  });
  await assert.rejects(failing.network.resolveShortLink(short), (error) => {
    assert.deepEqual(safeError(error), {
      error: "NETWORK_FAILED",
      message: "NETWORK_FAILED",
    });
    return true;
  });
  assert.equal(calls, 1);
  const spent = networkFixture(t, async () => assert.fail("Unexpected"), {
    requests: 0,
  });
  await assert.rejects(spent.network.resolveShortLink(short), {
    code: "REQUESTS_BUDGET",
  });
  const controller = new AbortController();
  const cancelled = networkFixture(
    t,
    async () => {
      controller.abort();
      throw new Error("aborted");
    },
    { signal: controller.signal },
  );
  await assert.rejects(cancelled.network.resolveShortLink(short), {
    code: "CANCELLED",
  });
  const paused = networkFixture(t, async () => assert.fail("Unexpected"));
  paused.store.pause("SYNTHETIC_RISK");
  await assert.rejects(paused.network.resolveShortLink(short), {
    code: "PERSISTENT_PAUSE",
  });
  const denied = networkFixture(t, async () => assert.fail("Unexpected"));
  await assert.rejects(
    denied.network.resolveShortLink("https://synthetic.test/AbC123"),
    { code: "URL_DENIED" },
  );
  // The ordinary transport has no route to a short link host.
  await assert.rejects(denied.network.get(short, "shortlink"), {
    code: "URL_DENIED",
  });
  assert.equal(denied.budget.requests, 0);
});

function readFixture(t, location, { config = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "humanism-short-")));
  const calls = [];
  const service = new Service(
    { dataDir: root, ...config },
    {
      fetcher: async (url, request) => {
        const u = new URL(url);
        calls.push({ url: u, request });
        if (["b23.tv", "bili2233.cn"].includes(u.hostname))
          return moved(location);
        if (u.pathname === "/x/web-interface/view")
          return json({
            code: 0,
            data: {
              title: "Synthetic source",
              owner: { mid: 1 },
              pages: [
                { page: 1, cid: 7, duration: 60 },
                { page: 2, cid: 8, duration: 60 },
              ],
            },
          });
        if (u.pathname === "/x/web-interface/nav") return json(wbiNav);
        if (u.pathname === "/x/player/wbi/v2")
          return json({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  {
                    lan: "zh-CN",
                    subtitle_url: "https://aisubtitle.hdslb.com/synthetic.json",
                  },
                ],
              },
            },
          });
        if (u.pathname === "/synthetic.json")
          return json({ body: [{ from: 0, to: 5, content: "Synthetic" }] });
        assert.fail("Unexpected synthetic endpoint");
      },
    },
  );
  t.after(() => service.close());
  return { root, service, calls };
}

test("reads resolve short links before video parsing and honour page rules", async (t) => {
  for (const [input, page, location, expected] of [
    [short, undefined, target, 1],
    ["b23.tv/AbC123", undefined, target, 1],
    ["https://bili2233.cn/AbC123", undefined, target, 1],
    ["bili2233.cn/AbC123", undefined, target, 1],
    [short, undefined, `${target}?p=2`, 2],
    [short, undefined, `${target}?p=abc`, 1],
    [short, 1, `${target}?p=2`, 1],
    [short, 2, target, 2],
  ]) {
    const f = readFixture(t, location);
    const read = await f.service.read(input, page);
    assert.equal(read.result.bvid, bv);
    assert.equal(read.result.page, expected);
    assert.equal(read.result.cid, expected === 2 ? 8 : 7);
    assert.equal(
      read.result.url,
      `https://www.bilibili.com/video/${bv}/?p=${expected}`,
    );
    assert.equal(read.usage.requests, 5);
    assert.ok(
      f.calls.every(
        ({ url }) =>
          !["www.bilibili.com", "m.bilibili.com"].includes(url.hostname),
      ),
      "The redirect target is never fetched",
    );
  }
});

test("one short link costs one GET in six hours, and a failure is not remembered", async (t) => {
  const f = readFixture(t, target);
  const hits = (fixture) =>
    fixture.calls.filter(({ url }) => url.hostname === "b23.tv").length;
  await f.service.read(short);
  await f.service.read(short);
  assert.equal(hits(f), 1);
  await f.service.read("https://b23.tv/Other1");
  assert.equal(hits(f), 2, "another code is another entry");
  f.service.store.db
    .prepare("UPDATE cache SET created=? WHERE key LIKE 'shortlink-%'")
    .run(Date.now() - 7 * 3600 * 1000);
  await f.service.read(short);
  assert.equal(hits(f), 3, "an old answer is asked again");
  const bad = readFixture(t, "https://synthetic.test/nope");
  for (let i = 0; i < 2; i += 1)
    await assert.rejects(bad.service.read(short), { code: "INVALID_VIDEO" });
  assert.equal(hits(bad), 2);
});

test("short link credentials stay on API requests", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "humanism-short-credential-"));
  const credentialPath = join(dir, "credential.json");
  writeFileSync(
    credentialPath,
    JSON.stringify({ sessdata: "SYNTHETIC_SESSION" }),
  );
  const f = readFixture(t, target, { config: { credentialPath } });
  await f.service.read(short);
  assert.equal(f.calls[0].url.href, short);
  assert.equal(f.calls[0].request.headers.Cookie, undefined);
  assert.match(f.calls[1].request.headers.Cookie, /SYNTHETIC_SESSION/);
});

test("a rejected short link stops the read with no further request", async (t) => {
  for (const [location, code] of [
    ["https://synthetic.test/elsewhere", "INVALID_VIDEO"],
    [`${target}?p=0`, "INVALID_PAGE"],
    [`${target}?p=101`, "INVALID_PAGE"],
  ]) {
    const f = readFixture(t, location);
    await assert.rejects(f.service.read(short), { code });
    assert.equal(f.calls.length, 1);
  }
  for (const input of [
    "https://b23.tv/a/b",
    "b23.tv/a?x=1",
    "http://b23.tv/AbC123",
    "b23.tv/" + "a".repeat(17),
  ]) {
    const f = readFixture(t, target);
    await assert.rejects(f.service.read(input), { code: "INVALID_VIDEO" });
    assert.equal(f.calls.length, 0, input);
  }
});
