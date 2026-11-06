import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Network, RESPONSE_BYTE_LIMITS, permitted } from "../lib/network.mjs";
import { firstMediaBytes } from "../lib/visual-media.mjs";

const cdn = "https://synthetic.bilivideo.com/media.m4s";
const backup = "https://backup.bilivideo.com/media.m4s";
const bytes = Buffer.from("SYNTHETIC_MEDIA");
function fixture(t, fetcher) {
  const root = mkdtempSync(join(tmpdir(), "humanism-range-"));
  const credentialPath = join(root, "credential.json");
  writeFileSync(credentialPath, '{"sessdata":"SYNTHETIC_SECRET"}');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = { requests: 0, paused: null };
  const budget = {
    spend() {
      state.requests++;
    },
    check() {},
    remaining() {
      return 5000;
    },
  };
  const network = new Network(
    {
      pause(reason) {
        state.paused = reason;
      },
    },
    budget,
    { credentialPath, fetcher },
  );
  return { network, budget, state };
}
function ranged(
  body = bytes,
  range = `bytes 0-${bytes.length - 1}/${bytes.length}`,
  headers = {},
) {
  return new Response(body, {
    status: 206,
    headers: { "content-range": range, ...headers },
  });
}

test("media requests ask for the full range and accept a complete 206 without CDN credentials", async (t) => {
  const f = fixture(t, async (_url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Cookie, undefined);
    if (options.headers.Range !== "bytes=0-")
      return new Response("", { status: 567 });
    return ranged(bytes, undefined, { "content-length": String(bytes.length) });
  });
  assert.deepEqual(await f.network.get(cdn, "media"), bytes);
  assert.equal(f.state.requests, 1);
  assert.equal(f.state.paused, null);
});

test("servers ignoring Range may return 200; API and subtitle requests never receive Range", async (t) => {
  const calls = [];
  const f = fixture(t, async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    return String(url) === cdn
      ? new Response(bytes)
      : new Response('{"code":0}');
  });
  assert.deepEqual(await f.network.get(cdn, "media"), bytes);
  await f.network.get("https://api.bilibili.com/x/web-interface/nav");
  await f.network.get(
    "https://aisubtitle.hdslb.com/synthetic.json",
    "subtitle",
  );
  assert.equal(calls[0].headers.Range, "bytes=0-");
  assert.equal(calls[1].headers.Range, undefined);
  assert.equal(calls[2].headers.Range, undefined);
  assert.equal(calls[1].headers.Cookie, "SESSDATA=SYNTHETIC_SECRET");
  assert.equal(calls[2].headers.Cookie, undefined);
});

test("206 media must describe one complete zero-based object, not a partial or unknown range", async (t) => {
  for (const range of [
    null,
    "bytes 1-3/4",
    "bytes 0-2/4",
    "bytes 0-3/*",
    "bytes */4",
    "bytes 0-3/0",
    "bytes 0-9007199254740992/9007199254740993",
  ]) {
    const f = fixture(
      t,
      async () =>
        new Response("DATA", {
          status: 206,
          headers: range === null ? {} : { "content-range": range },
        }),
    );
    await assert.rejects(
      f.network.get(cdn, "media"),
      { code: "BODY_READ_FAILED" },
      String(range),
    );
    assert.equal(f.state.paused, null);
  }
});

test("206 media verifies delivered bytes and Content-Length against the whole range", async (t) => {
  for (const headers of [{}, { "content-length": "3" }]) {
    const f = fixture(t, async () => ranged("DATA", "bytes 0-4/5", headers));
    await assert.rejects(f.network.get(cdn, "media"), {
      code: "BODY_READ_FAILED",
    });
  }
  const exact = fixture(t, async () => ranged("DATA", "bytes 0-3/4"));
  assert.equal((await exact.network.get(cdn, "media")).toString(), "DATA");
});

test("206 range and declared length each enforce the original media-byte cap", async (t) => {
  const total = RESPONSE_BYTE_LIMITS.media + 1;
  for (const response of [
    () => ranged("DATA", `bytes 0-${total - 1}/${total}`),
    () => ranged("DATA", "bytes 0-3/4", { "content-length": String(total) }),
    () =>
      new Response("DATA", {
        status: 206,
        headers: { "content-length": String(total) },
      }),
  ]) {
    const f = fixture(t, response);
    await assert.rejects(firstMediaBytes(f.network, f.budget, [cdn, backup]), {
      code: "RESPONSE_TOO_LARGE",
    });
    assert.equal(f.state.requests, 1);
  }
});

test("ordinary incomplete ranges may use a same-track backup; HTTP risk still stops immediately", async (t) => {
  const f = fixture(t, async (url) =>
    String(url) === cdn ? ranged("DATA", "bytes 0-3/5") : ranged(),
  );
  assert.deepEqual(
    await firstMediaBytes(f.network, f.budget, [cdn, backup]),
    bytes,
  );
  assert.equal(f.state.requests, 2);
  const risk = fixture(t, async () => new Response("", { status: 412 }));
  await assert.rejects(
    firstMediaBytes(risk.network, risk.budget, [cdn, backup]),
    { code: "PLATFORM_PAUSED" },
  );
  assert.equal(risk.state.requests, 1);
  assert.equal(risk.state.paused, "HTTP_412");
});

test("206 remains unavailable to JSON routes; media host policy is unchanged", async (t) => {
  const f = fixture(t, async () => ranged());
  await assert.rejects(
    f.network.get("https://aisubtitle.hdslb.com/synthetic.json", "subtitle"),
    { code: "HTTP_FAILED" },
  );
  assert.throws(
    () => permitted("https://synthetic.akamaized.net/media.m4s", "media"),
    { code: "URL_DENIED" },
  );
  assert.throws(
    () => permitted("https://synthetic.bilivideo.com:8082/media.m4s", "media"),
    { code: "URL_DENIED" },
  );
});
