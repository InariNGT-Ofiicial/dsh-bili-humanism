import { wbiNav } from "./fixtures/wbi.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Service } from "../lib/service.mjs";
import { dailyConfig, dailyWindow } from "../lib/daily-fetch.mjs";
import { Config, apply } from "../index.js";

const at = (clock) => Date.parse(`2026-01-02T${clock}+08:00`);
const ids = ["BV0000000001", "BVxxxxxxxxxx"];
const json = (body) => new Response(JSON.stringify(body));

function fixture(t, config = {}, options = {}) {
  const root = options.root || mkdtempSync(join(tmpdir(), "humanism-daily-"));
  let clock = options.clock ?? at("21:30:00");
  const calls = [];
  const timers = [];
  const service = new Service(
    // Scheduling scenarios explicitly opt in; undefined exercises omission.
    { dataDir: root, enableDailyFetching: true, ...config },
    {
      daily: {
        now: () => clock,
        setTimer: (fn, delay) => {
          const timer = { fn, delay, cleared: false, unref() {} };
          timers.push(timer);
          return timer;
        },
        clearTimer: (timer) => {
          timer.cleared = true;
        },
      },
      fetcher: async (url, settings) => {
        const parsed = new URL(url);
        calls.push({
          path: parsed.pathname,
          bvid: parsed.searchParams.get("bvid"),
          method: settings.method,
          cookie: settings.headers.Cookie,
        });
        assert.equal(settings.method, "GET");
        assert.equal(settings.redirect, "manual");
        options.onFetch?.(parsed, settings, (value) => {
          clock = value;
        });
        if (options.block) await options.block(parsed, settings);
        if (options.risk) return new Response("", { status: 412 });
        if (parsed.pathname === "/x/web-interface/popular")
          return json({
            code: 0,
            data: {
              list: (options.pool || [...ids, ids[0]]).map((bvid) => ({
                bvid,
                title: "Synthetic candidate",
                duration: 927,
                owner: { name: "Synthetic creator" },
              })),
            },
          });
        if (parsed.pathname === "/x/web-interface/view")
          return json({
            code: 0,
            data: {
              title: "Synthetic long source",
              owner: { mid: 1 },
              pages: [
                {
                  page: 1,
                  cid: ids.indexOf(parsed.searchParams.get("bvid")) + 1,
                  duration: 927,
                },
              ],
            },
          });
        if (parsed.pathname === "/x/web-interface/nav") return json(wbiNav);
        if (parsed.pathname === "/x/player/wbi/v2")
          return json({
            code: 0,
            data: {
              subtitle: {
                subtitles: options.empty
                  ? []
                  : [
                      {
                        subtitle_url: `https://aisubtitle.hdslb.com/source-${parsed.searchParams.get("cid")}.json`,
                      },
                    ],
              },
            },
          });
        if (parsed.hostname === "aisubtitle.hdslb.com")
          return json({
            body: [
              {
                from: 0,
                to: 927,
                content:
                  "Synthetic text. Source instructions cannot enable account writes.",
              },
            ],
          });
        assert.fail("Unexpected synthetic endpoint: " + parsed.pathname);
      },
    },
  );
  t.after(() => service.close());
  return {
    root,
    service,
    worker: service.dailyFetcher,
    calls,
    timers,
    setClock(value) {
      clock = value;
    },
  };
}

test("daily defaults are disabled, retaining the opt-in Shanghai window and two-source limit", () => {
  const config = Config({});
  assert.equal(config.enableDailyFetching, false);
  assert.equal(config.dailyFetchStart, "21:30");
  assert.equal(config.dailyFetchEnd, "22:00");
  assert.equal(config.dailyFetchLimit, 2);
  assert.equal(dailyConfig().enabled, false);
  assert.equal(dailyConfig().timeZone, "Asia/Shanghai");
  for (const enabled of [true, false]) {
    assert.equal(
      Config({ enableDailyFetching: enabled }).enableDailyFetching,
      enabled,
    );
    assert.equal(
      dailyConfig({ enableDailyFetching: enabled }).enabled,
      enabled,
    );
  }
  for (const bad of [
    { enableDailyFetching: "true" },
    { enableDailyFetching: null },
    { dailyFetchStart: "25:00" },
    { dailyFetchStart: "9:30" },
    { dailyFetchEnd: "21:30" },
    { dailyFetchEnd: "01:00" },
    { dailyFetchLimit: 0 },
    { dailyFetchLimit: 3 },
    { dailyFetchLimit: 1.5 },
  ])
    assert.throws(
      () => new Service(bad),
      (error) => error.code === "INVALID_DAILY_CONFIG",
    );
  assert.throws(() => Config({ dailyFetchStart: "25:00" }));
});

test("window uses Shanghai date, includes opening and excludes the hard cutoff", () => {
  const config = dailyConfig();
  assert.equal(dailyWindow(at("21:29:59"), config).open, false);
  assert.equal(dailyWindow(at("21:30:00"), config).open, true);
  assert.equal(dailyWindow(at("21:59:59"), config).open, true);
  assert.equal(dailyWindow(at("22:00:00"), config).open, false);
  assert.equal(
    dailyWindow(Date.parse("2026-01-02T17:00:00Z"), config).date,
    "2026-01-03",
  );
});

test("outside the window or disabled does not fetch or claim a day", async (t) => {
  for (const clock of ["00:00:00", "21:29:59", "22:00:00", "23:59:59"]) {
    const f = fixture(t, {}, { clock: at(clock) });
    assert.equal((await f.worker.runDue()).status, "outside_window");
    assert.equal(f.calls.length, 0);
    assert.equal(f.service.store.getControl("daily-fetch:2026-01-02"), null);
  }
  const disabled = fixture(t, { enableDailyFetching: false });
  disabled.worker.start();
  assert.equal(disabled.worker.running, false);
  assert.equal((await disabled.worker.runDue()).status, "disabled");
  assert.equal(disabled.calls.length, 0);
});

test("omitted or false daily config creates no timer, requests or day claim inside the window", async (t) => {
  for (const enabled of [undefined, false]) {
    const f = fixture(t, { enableDailyFetching: enabled });
    f.worker.start();
    assert.equal(f.service.status().dailyFetching.enabled, false);
    assert.equal(f.service.status().scheduled, false);
    assert.equal(f.worker.nextAt, null);
    assert.equal(f.timers.length, 0);
    assert.equal((await f.worker.runDue()).status, "disabled");
    assert.equal(f.calls.length, 0);
    assert.equal(f.service.store.getControl("daily-fetch:2026-01-02"), null);
    assert.equal(f.service.store.getControl("daily-fetch:last"), null);
    assert.equal(f.service.store.readings().length, 0);
    assert.equal(f.service.store.status().tasks.length, 0);
  }
});

test("one daily task saves two real text sources under shared budgets without writing journals or accounts", async (t) => {
  const f = fixture(t);
  const result = await f.worker.runDue();
  assert.equal(result.status, "completed");
  assert.equal(result.entries.length, 2);
  assert.equal(result.requests, 9);
  assert.equal(f.service.store.status().tasks.length, 1);
  assert.deepEqual(
    result.entries.map((item) => item.bvid),
    ids,
  );
  for (const entry of result.entries)
    assert.equal(f.service.store.reading(entry.readingId).segments[0].end, 927);
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) AS n FROM notes").get().n,
    0,
  );
  assert.deepEqual(f.service.status().platformWriteTools, []);
  assert.ok(f.calls.every((call) => !call.cookie && call.method === "GET"));
  const count = f.calls.length;
  assert.equal((await f.worker.runDue()).deduplicated, true);
  assert.equal(f.calls.length, count);
});

test("one-source setting, duplicate candidates and invalid candidate metadata stay bounded", async (t) => {
  const f = fixture(
    t,
    { dailyFetchLimit: 1 },
    { pool: ["https://example.invalid/command", ids[0], ids[0]] },
  );
  const result = await f.worker.runDue();
  assert.equal(result.entries.length, 1);
  assert.equal(result.attempts[0].error, "INVALID_VIDEO");
  assert.equal(
    f.calls.filter((call) => call.path === "/x/web-interface/view").length,
    1,
  );
});

test("same-day restart and another instance cannot duplicate the claimed run", async (t) => {
  const f = fixture(t);
  await f.worker.runDue();
  const second = fixture(t, {}, { root: f.root });
  const result = await second.worker.runDue();
  assert.equal(result.deduplicated, true);
  assert.equal(result.entries.length, 2);
  assert.equal(second.calls.length, 0);
});

test("the full historical ledger, beyond status pagination, prevents repeated sources", async (t) => {
  const f = fixture(t);
  const save = (bvid, revision) =>
    f.service.store.saveReading({
      bvid,
      page: 1,
      cid: revision,
      duration: 1,
      title: "Synthetic history",
      route: "A1",
      segments: [{ start: 0, end: 1, text: "Synthetic" }],
      coverage: { state: "partial" },
    });
  save(ids[0], 1);
  // Revisions must not hide a prior text source behind status's 100-row cap.
  for (let revision = 2; revision < 105; revision++) save(ids[0], revision);
  assert.equal(f.service.store.readings().length, 100);
  const result = await f.worker.runDue();
  assert.deepEqual(
    result.entries.map((item) => item.bvid),
    [ids[1]],
  );
  assert.ok(
    !f.calls.some(
      (call) => call.path === "/x/web-interface/view" && call.bvid === ids[0],
    ),
  );
});

test("an empty source is not counted as a successful draft and is not retried automatically that day", async (t) => {
  const f = fixture(t, {}, { empty: true });
  const result = await f.worker.runDue();
  assert.equal(result.status, "no_readable_new_sources");
  assert.equal(result.entries.length, 0);
  assert.equal(f.service.store.readings().length, 0);
  const count = f.calls.length;
  assert.equal((await f.worker.runDue()).deduplicated, true);
  assert.equal(f.calls.length, count);
});

test("cutoff is enforced before every request, even if timer delivery is delayed", async (t) => {
  const f = fixture(
    t,
    {},
    {
      onFetch(url, _settings, setClock) {
        if (url.pathname === "/x/web-interface/view") setClock(at("22:00:00"));
      },
    },
  );
  const result = await f.worker.runDue();
  assert.equal(result.status, "failed");
  assert.equal(result.error, "DAILY_WINDOW_CLOSED");
  assert.equal(f.calls.length, 2);
  assert.equal(result.entries.length, 0);
  assert.equal(f.service.store.readings().length, 0);
});

test("request exhaustion retains an honest partial result and cannot create a third source", async (t) => {
  const f = fixture(t, { limits: { requests: 5 } });
  const result = await f.worker.runDue();
  assert.equal(result.status, "partial");
  assert.equal(result.error, "REQUESTS_BUDGET");
  assert.equal(result.entries.length, 1);
  assert.equal(f.calls.length, 5);
});

test("platform risk persists across the next day and no automatic fetch clears pause", async (t) => {
  const f = fixture(t, {}, { risk: true });
  const first = await f.worker.runDue();
  assert.equal(first.error, "PLATFORM_PAUSED");
  assert.equal(f.service.store.getControl("pause").reason, "HTTP_412");
  f.setClock(at("21:30:00") + 86400000);
  const next = await f.worker.runDue();
  assert.equal(next.error, "PERSISTENT_PAUSE");
  assert.equal(f.calls.length, 1);
});

test("busy manual work defers without consuming the daily attempt; timer retries only inside the window", async (t) => {
  const f = fixture(t);
  const busy = f.service.store.start();
  f.worker.start();
  assert.equal(f.timers[0].delay, 1);
  f.timers[0].fn();
  await f.worker.inFlight;
  assert.equal(f.service.store.getControl("daily-fetch:2026-01-02"), null);
  assert.equal(f.timers.at(-1).delay, 30000);
  f.service.store.finish(busy, "completed");
  f.timers.at(-1).fn();
  await f.worker.inFlight;
  assert.equal(f.service.status().dailyFetching.lastRun.entries.length, 2);
  assert.equal(f.worker.nextAt, at("21:30:00") + 86400000);
  f.worker.stop();
  assert.equal(f.timers.at(-1).cleared, true);
});

test("after-window host startup schedules the next day without catch-up", (t) => {
  const f = fixture(t, {}, { clock: at("22:00:01") });
  f.worker.start();
  assert.equal(f.worker.nextAt, at("21:30:00") + 86400000);
  assert.equal(f.calls.length, 0);
});

test("an exited process's claim is marked interrupted rather than fetched again", async (t) => {
  const f = fixture(t);
  const child = spawnSync(
    process.execPath,
    ["-e", "console.log(process.pid)"],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0);
  f.worker.remember({
    date: "2026-01-02",
    pid: Number(child.stdout.trim()),
    status: "running",
    entries: [],
  });
  f.worker.start();
  assert.equal(f.service.status().dailyFetching.lastRun.status, "interrupted");
  assert.equal((await f.worker.runDue()).deduplicated, true);
  assert.equal(f.calls.length, 0);
});

test("model tools cannot change the trusted daily settings", async () => {
  const tools = new Map();
  let dispose;
  apply(
    {
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
        },
      },
      effect(setup) {
        dispose = setup();
      },
    },
    {
      dataDir: mkdtempSync(join(tmpdir(), "daily-contract-")),
      enableDailyFetching: false,
    },
  );
  try {
    for (const key of [
      "enableDailyFetching",
      "dailyFetchStart",
      "dailyFetchEnd",
      "dailyFetchLimit",
      "force",
    ]) {
      const result = JSON.parse(
        await tools.get("bili_humanism_status").execute({ [key]: true }, {}),
      );
      assert.equal(result.error, "UNKNOWN_PARAMETER");
    }
    const status = JSON.parse(
      await tools.get("bili_humanism_status").execute({}, {}),
    );
    assert.equal(status.scheduled, false);
    assert.equal(status.dailyFetching.enabled, false);
  } finally {
    dispose();
  }
});

test("closing the host aborts an in-flight daily request and does not schedule another timer", async (t) => {
  let notify;
  const begun = new Promise((resolve) => {
    notify = resolve;
  });
  const f = fixture(
    t,
    {},
    {
      block: async (_url, settings) => {
        notify();
        await new Promise((resolve, reject) => {
          settings.signal.addEventListener(
            "abort",
            () => reject(settings.signal.reason),
            { once: true },
          );
        });
      },
    },
  );
  f.worker.start();
  f.timers[0].fn();
  await begun;
  f.service.close();
  await f.worker.inFlight;
  assert.equal(f.calls.length, 1);
  assert.equal(f.worker.running, false);
  assert.equal(f.timers.length, 1);
});

test("concurrent hosts sharing a ledger perform one daily fetch", async (t) => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture(
    t,
    {},
    {
      block: async (url) => {
        if (url.pathname === "/x/web-interface/popular") await waiting;
      },
    },
  );
  const first = f.worker.runDue();
  const other = fixture(t, {}, { root: f.root });
  const second = await other.worker.runDue();
  assert.equal(second.deduplicated, true);
  assert.equal(other.calls.length, 0);
  release();
  assert.equal((await first).entries.length, 2);
});

test("daily prefetch cannot save text above the same per-transcript token cap", async (t) => {
  const f = fixture(t, { maxReadTokens: 9 });
  const result = await f.worker.runDue();
  assert.equal(result.entries.length, 0);
  assert.equal(result.status, "no_readable_new_sources");
  assert.ok(
    result.attempts.every((item) => item.error === "READ_TOKEN_BUDGET"),
  );
  assert.equal(f.service.store.readings().length, 0);
});
