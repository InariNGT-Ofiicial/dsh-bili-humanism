import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Service, readingView } from "../lib/service.mjs";
import { Store, digest } from "../lib/store.mjs";
import { checkReadTokenBudget, readTokenLimit } from "../lib/token-gate.mjs";
import * as plugin from "../index.js";

const temp = () => mkdtempSync(join(tmpdir(), "humanism-read-tokens-"));
const video = "BV0000000001";
const fixture = {
  bvid: video,
  page: 1,
  cid: 7,
  duration: 60,
  url: `https://www.bilibili.com/video/${video}/?p=1`,
  title: "Synthetic token fixture",
  route: "none",
  segments: [],
  coverage: { state: "no_subtitles" },
};
function chunks(bytes, letter = "a") {
  return Array.from({ length: Math.ceil(bytes / 20000) }, (_, index) => ({
    start: index / 100,
    end: (index + 1) / 100,
    text: letter.repeat(Math.min(20000, bytes - index * 20000)),
  }));
}
const reply = (body) => new Response(JSON.stringify(body));
function sourceFetcher(state) {
  return async (url) => {
    state.calls++;
    const path = new URL(url).pathname;
    if (path === "/x/web-interface/view")
      return reply({
        code: 0,
        data: {
          title: "Synthetic token fixture",
          owner: { name: "Synthetic author" },
          pages: [{ page: 1, cid: 7, duration: 60 }],
          duration: 60,
        },
      });
    if (path === "/x/player/v2")
      return reply({
        code: 0,
        data: {
          subtitle: {
            subtitles: state.segments.length
              ? [
                  {
                    lan: "zh",
                    subtitle_url: "https://aisubtitle.hdslb.com/synthetic.json",
                  },
                ]
              : [],
          },
        },
      });
    if (path === "/synthetic.json") return reply({ body: state.segments });
    throw new Error("Unexpected synthetic request");
  };
}

test("human per-transcript limit accepts new config and the legacy alias with explicit precedence", () => {
  assert.equal(readTokenLimit(plugin.Config({})), 600_000);
  for (const key of ["maxReadTokens", "maxSessionTokens"]) {
    for (const value of [1, 60_000, 1_200_000, Number.MAX_SAFE_INTEGER]) {
      const config = plugin.Config({ [key]: value });
      assert.equal(readTokenLimit(config), value);
      const service = new Service({ ...config, dataDir: temp() });
      assert.equal(service.status().tokens.limit, value);
      service.close();
    }
    for (const value of [
      0,
      -1,
      1.5,
      null,
      "600000",
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(() => readTokenLimit({ [key]: value }), {
        code: "INVALID_TOKEN_LIMIT",
      });
      // The pinned host schema treats null as an omitted/default field.
      if (value !== null) assert.throws(() => plugin.Config({ [key]: value }));
    }
  }
  assert.equal(
    readTokenLimit(plugin.Config({ maxReadTokens: 12, maxSessionTokens: 1 })),
    12,
  );
});

test("UTF-8 estimate counts all segment bodies, exact boundary and fresh attempts independently", () => {
  const store = new Store(temp());
  const segments = [{ text: "ab" }, { text: "中🙂" }];
  assert.equal(checkReadTokenBudget(store, segments, 9).used, 9);
  assert.equal(checkReadTokenBudget(store, segments, 9).used, 9);
  assert.throws(() => checkReadTokenBudget(store, segments, 8), {
    code: "READ_TOKEN_BUDGET",
  });
  assert.equal(store.getControl("read-token-status").allowed, false);
  assert.equal(checkReadTokenBudget(store, [], 8).used, 0);
  store.close();
});

test("600k applies to the full fetched transcript, never session totals or only the first page", async () => {
  const state = { calls: 0, segments: chunks(600_001) };
  const service = new Service(
    { dataDir: temp() },
    { fetcher: sourceFetcher(state) },
  );
  await assert.rejects(service.read(video), { code: "READ_TOKEN_BUDGET" });
  assert.equal(service.store.readings().length, 0);
  assert.equal(service.status().tokens.lastAttempt.used, 600_001);
  const calls = state.calls;
  // A cached oversized body must not bypass the current limit.
  await assert.rejects(service.read(video), { code: "READ_TOKEN_BUDGET" });
  assert.equal(state.calls, calls);
  assert.equal(service.store.status().tasks[0].error, "READ_TOKEN_BUDGET");
  for (const letter of ["a", "b"]) {
    service.store.db.prepare("DELETE FROM cache").run();
    state.segments = chunks(600_000, letter);
    const read = await service.read(video);
    assert.equal(read.result.tokenBudget.used, 600_000);
    assert.equal(read.usage.tokens, null);
    const first = readingView(read.result);
    assert.equal(first.segment_count, 30);
    assert.ok(first.next_offset > 0);
    assert.ok(first.source_text_partial);
  }
  assert.equal(service.store.readings().length, 2);
  service.close();
});

test("cached subtitles recheck human config after reload; a failure does not consume the next allowance", async () => {
  const dataDir = temp(),
    state = { calls: 0, segments: [{ start: 0, end: 1, text: "Synthetic" }] };
  let service = new Service(
    { dataDir, maxReadTokens: 9 },
    { fetcher: sourceFetcher(state) },
  );
  const first = (await service.read(video)).result;
  assert.equal((await service.read(video)).result.id, first.id);
  const calls = state.calls;
  service.close();
  service = new Service(
    { dataDir, maxReadTokens: 8 },
    { fetcher: sourceFetcher(state) },
  );
  await assert.rejects(service.read(video), { code: "READ_TOKEN_BUDGET" });
  assert.equal(state.calls, calls);
  assert.equal(
    readingView(service.store.reading(first.id)).segments[0].text,
    "Synthetic",
  );
  service.close();
  service = new Service(
    { dataDir, maxReadTokens: 9 },
    { fetcher: sourceFetcher(state) },
  );
  assert.equal((await service.read(video)).result.tokenBudget.used, 9);
  assert.equal(state.calls, calls);
  service.close();
});

test("automatic visual reads enforce the full transcript limit before media work and do not swallow it", async () => {
  const dataDir = temp();
  const state = {
    calls: 0,
    segments: [{ start: 0, end: 1, text: "Synthetic" }],
  };
  let spawns = 0;
  const dependencies = {
    fetcher: sourceFetcher(state),
    spawn() {
      spawns++;
      throw new Error("Synthetic missing frame runtime");
    },
  };
  let service = new Service({ dataDir, maxReadTokens: 8 }, dependencies);
  await assert.rejects(service.readVisual(video), {
    code: "READ_TOKEN_BUDGET",
  });
  assert.equal(spawns, 0);
  assert.equal(service.store.readings().length, 0);
  assert.equal(state.calls, 3);
  service.close();
  service = new Service({ dataDir, maxReadTokens: 9 }, dependencies);
  const result = await service.readVisual(video);
  assert.equal(result.result.tokenBudget.used, 9);
  assert.equal(result.result.visual.status, "unavailable");
  assert.equal(result.result.visual.error, "FRAME_DEPENDENCIES_UNAVAILABLE");
  assert.equal(spawns, 1);
  assert.equal(result.usage.requests, 0);
  service.close();
});

test("A3 and frame imports share the per-transcript boundary and preserve existing records on failure", async () => {
  const service = new Service({ dataDir: temp(), maxReadTokens: 9 });
  const base = service.store.saveReading(fixture);
  for (const route of ["A3", "frame"]) {
    for (const letter of ["a", "b"]) {
      const raw = { route, duration: 60, segments: chunks(9, letter) };
      const result = (await service.importLocal(base.id, raw)).result;
      assert.equal(result.tokenBudget.used, 9);
      assert.equal(
        (await service.importLocal(base.id, raw)).result.id,
        result.id,
      );
    }
    const count = service.store.readings().length;
    await assert.rejects(
      service.importLocal(base.id, {
        route,
        duration: 60,
        segments: chunks(10),
      }),
      { code: "READ_TOKEN_BUDGET" },
    );
    assert.equal(service.store.readings().length, count);
  }
  assert.equal(service.store.reading(base.id).segments.length, 0);
  service.close();
});

test("unconfirmed network read checks the whole A3 with the current limit after restart", async () => {
  const dataDir = temp(),
    state = { calls: 0, segments: [] };
  let service = new Service(
    { dataDir, maxReadTokens: 9 },
    { fetcher: sourceFetcher(state) },
  );
  const empty = (await service.read(video)).result;
  const imported = (
    await service.importLocal(empty.id, {
      route: "A3",
      duration: 60,
      segments: chunks(9),
    })
  ).result;
  assert.equal((await service.read(video)).result.id, imported.id);
  service.close();
  service = new Service(
    { dataDir, maxReadTokens: 8 },
    { fetcher: sourceFetcher(state) },
  );
  const calls = state.calls;
  await assert.rejects(service.read(video), { code: "READ_TOKEN_BUDGET" });
  assert.equal(state.calls, calls + 2);
  assert.equal(service.store.reading(imported.id).segments[0].text.length, 9);
  service.close();
});

test("registered tools ignore old over-limit session controls and never request host usage projections", async () => {
  const dataDir = temp(),
    tools = new Map();
  const seed = new Store(dataDir);
  const oldKey = "token-session:" + digest("old-session");
  const oldState = { baseline: 100, lastTotal: 9_000_000 };
  seed.setControl(oldKey, oldState);
  seed.setControl("token-status", {
    kind: "provider_session_delta",
    used: 8_999_900,
    limit: 600_000,
  });
  const reading = seed.saveReading(fixture);
  seed.close();
  let dispose;
  plugin.apply(
    {
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
        },
      },
      effect(setup) {
        dispose = setup();
      },
      get() {
        throw new Error("Must not inspect unrelated session usage");
      },
    },
    plugin.Config({ dataDir, maxReadTokens: 9, enableDailyFetching: false }),
  );
  const exec = { agent: { session: { id: "old-session" } } };
  const call = async (name, args) =>
    JSON.parse(await tools.get("bili_humanism_" + name).execute(args, exec));
  try {
    assert.equal(
      (
        await call("memory", {
          action: "put",
          id: "self",
          json: JSON.stringify({
            subject: "self",
            understanding: "Synthetic",
            evidence: "Synthetic",
          }),
        })
      ).revision,
      1,
    );
    const journal = await call("journal", {
      readingId: reading.id,
      json: JSON.stringify({
        encounter: "Synthetic",
        missing: "Synthetic limits",
        revision: "Synthetic reflection",
        evidence: [],
      }),
    });
    assert.ok(journal.id);
    await call("personality", { action: "read", journalId: journal.id });
    assert.equal(
      (
        await call("personality", {
          action: "select",
          journalId: journal.id,
          sentence: "Synthetic reflection",
        })
      ).status,
      "selected",
    );
    const args = {
      readingId: reading.id,
      json: JSON.stringify({ route: "A3", duration: 60, segments: chunks(9) }),
    };
    assert.equal((await call("import", args)).result.tokenBudget.used, 9);
    assert.equal((await call("import", args)).result.tokenBudget.used, 9);
    for (const key of ["maxReadTokens", "maxSessionTokens", "force"])
      assert.equal(
        (await call("read", { video, [key]: 1_200_000 })).error,
        "UNKNOWN_PARAMETER",
      );
    const status = await call("status", {});
    assert.equal(status.tokens.scope, "per_transcript");
    assert.equal(status.tokens.limit, 9);
    assert.deepEqual(status.platformWriteTools, []);
    const inspect = new Store(dataDir);
    assert.deepEqual(inspect.getControl(oldKey), oldState);
    assert.equal(inspect.getControl("token-status").used, 8_999_900);
    inspect.close();
  } finally {
    dispose();
  }
});

test("local CLI applies the human per-transcript limit and legacy alias without host metering", () => {
  const dataDir = temp(),
    store = new Store(dataDir);
  const reading = store.saveReading(fixture);
  store.close();
  const raw = join(dataDir, "synthetic-source.json"),
    config = join(dataDir, "synthetic-config.json");
  writeFileSync(
    raw,
    JSON.stringify({ route: "A3", duration: 60, segments: chunks(9) }),
  );
  for (const [key, limit, expectedExit] of [
    ["maxReadTokens", 8, 1],
    ["maxSessionTokens", 8, 1],
    ["maxReadTokens", 9, 0],
  ]) {
    writeFileSync(config, JSON.stringify({ dataDir, [key]: limit }));
    const result = spawnSync(
      process.execPath,
      ["bin/cli.mjs", "import", reading.id, raw],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, BILI_HUMANISM_CONFIG_FILE: config },
      },
    );
    assert.equal(result.status, expectedExit);
    if (expectedExit) assert.match(result.stderr, /READ_TOKEN_BUDGET/);
    else assert.equal(JSON.parse(result.stdout).result.tokenBudget.used, 9);
  }
});
