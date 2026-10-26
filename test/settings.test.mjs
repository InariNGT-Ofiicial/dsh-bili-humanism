import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DEFAULTS,
  applyLive,
  clearSettings,
  loadSettings,
  mergeSettings,
  settingsFile,
  validateSettings,
  writeSettings,
} from "../lib/settings.mjs";
import {
  PREFIX,
  createSettingsApi,
  registerSettingsRoutes,
} from "../lib/settings-http.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "humanism-settings-"));

function fakeService(root) {
  const daily = {
    config: { enabled: false, start: "21:30", end: "22:00", limit: 2 },
    running: false,
    stop() {
      this.running = false;
    },
    start() {
      this.running = this.config.enabled;
    },
    status() {
      return { ...this.config, running: this.running };
    },
  };
  return {
    config: {
      dataDir: root,
      maxReadTokens: 600000,
      maxSessionTokens: 600000,
      pythonPath: "",
      asrModelPath: "",
      credentialPath: "",
      writePolicyPath: "",
      accountStateDir: "",
      enableHistoryWrites: false,
      enableFavoriteWrites: false,
      enableLikeWrites: false,
      enableCoinWrites: false,
      enablePersonalityLearning: true,
      enablePersonalityShadow: false,
      shadowMaxReviewsPerDay: 2,
      enableDailyFetching: false,
      dailyFetchStart: "21:30",
      dailyFetchEnd: "22:00",
      dailyFetchLimit: 2,
    },
    limits: { asrSeconds: Number.MAX_SAFE_INTEGER },
    store: { root },
    dailyFetcher: daily,
  };
}

function fakeResponse() {
  return {
    headersSent: false,
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
      this.headersSent = true;
    },
  };
}

async function call(route, { method = "GET", json } = {}) {
  const req = Readable.from(
    json === undefined ? [] : [Buffer.from(JSON.stringify(json))],
  );
  req.method = method;
  const res = fakeResponse();
  await route.handler(req, res);
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

test("validateSettings keeps the whitelist and rejects bad shapes", () => {
  const good = validateSettings({
    maxReadTokens: 1234,
    dailyFetchStart: "09:00",
    dailyFetchEnd: "10:30",
    dailyFetchLimit: 1,
    shadowMaxReviewsPerDay: 5,
    enablePersonalityShadow: true,
    pythonPath: "",
    maxMediaSeconds: null,
  });
  assert.deepEqual(good.errors, []);
  assert.equal(good.values.maxReadTokens, 1234);
  assert.equal(good.values.maxMediaSeconds, null);

  for (const [label, input] of Object.entries({
    unknown: { evil: 1 },
    zero: { maxReadTokens: 0 },
    negative: { maxReadTokens: -5 },
    limit: { dailyFetchLimit: 3 },
    shadowRange: { shadowMaxReviewsPerDay: 11 },
    shadowZero: { shadowMaxReviewsPerDay: 0 },
    badTime: { dailyFetchStart: "9:30" },
    order: { dailyFetchStart: "22:00", dailyFetchEnd: "21:00" },
    relativePython: { pythonPath: "python.exe" },
    notBoolean: { enableLikeWrites: "yes" },
    notObject: null,
  })) {
    const checked = validateSettings(input);
    assert.ok(checked.errors.length > 0, label);
  }
});

test("mergeSettings applies the overlay and lets null delete a key", () => {
  const base = { maxReadTokens: 600000, pythonPath: "C:/a/python.exe" };
  const merged = mergeSettings(base, { maxReadTokens: 1000, maxMediaSeconds: null });
  assert.equal(merged.maxReadTokens, 1000);
  assert.equal(merged.pythonPath, "C:/a/python.exe");
  assert.equal(Object.hasOwn(merged, "maxMediaSeconds"), false);
});

test("write/load/clear round-trips with a backup", () => {
  const root = temp();
  const config = { dataDir: root };
  writeSettings(config, { maxReadTokens: 2048 });
  const file = settingsFile(config);
  assert.ok(existsSync(file));
  const loaded = loadSettings(config);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.values.maxReadTokens, 2048);
  assert.equal(loaded.error, null);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.values.maxReadTokens, 2048);
  assert.ok(Array.isArray(Object.keys(raw)) && raw.version === 1);

  writeSettings(config, { maxReadTokens: 4096 });
  assert.ok(existsSync(`${file}.bak`));
  assert.equal(loadSettings(config).values.maxReadTokens, 4096);

  assert.equal(clearSettings(config), true);
  assert.equal(existsSync(file), false);
  assert.equal(loadSettings(config).exists, false);
  rmSync(root, { recursive: true, force: true });
});

test("a malformed overlay is reported and ignored", () => {
  const root = temp();
  const config = { dataDir: root };
  writeFileSync(join(root, "settings.json"), "{not json", "utf8");
  const loaded = loadSettings(config);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.error, "SETTINGS_UNREADABLE");
  assert.deepEqual(loaded.values, {});
  rmSync(root, { recursive: true, force: true });
});

test("applyLive pushes call-time keys and defers registration keys", () => {
  const root = temp();
  const service = fakeService(root);
  const live = applyLive(service, {
    maxReadTokens: 777,
    pythonPath: "C:/py/python.exe",
    enableLikeWrites: true,
    enablePersonalityShadow: true,
    shadowMaxReviewsPerDay: 4,
    enableDailyFetching: true,
    dailyFetchStart: "20:00",
    dailyFetchEnd: "20:30",
    dailyFetchLimit: 1,
  });
  assert.equal(service.config.maxReadTokens, 777);
  assert.equal(service.config.pythonPath, "C:/py/python.exe");
  assert.equal(service.config.enableLikeWrites, true);
  assert.ok(live.applied.includes("maxReadTokens"));
  assert.ok(live.applied.includes("pythonPath"));
  assert.ok(live.restart.includes("enableLikeWrites"));
  assert.ok(live.restart.includes("enablePersonalityShadow"));
  assert.equal(service.config.shadowMaxReviewsPerDay, 4);
  assert.equal(service.dailyFetcher.config.enabled, true);
  assert.equal(service.dailyFetcher.config.limit, 1);
  assert.ok(live.applied.includes("dailyFetch"));
  rmSync(root, { recursive: true, force: true });
});

test("applyLive restores defaults when the overlay is cleared", () => {
  const root = temp();
  const service = fakeService(root);
  service.config.maxReadTokens = 999;
  service.config.pythonPath = "C:/py/python.exe";
  applyLive(service, {});
  assert.equal(service.config.maxReadTokens, DEFAULTS.maxReadTokens);
  assert.equal(service.config.pythonPath, DEFAULTS.pythonPath);
  rmSync(root, { recursive: true, force: true });
});

test("the page state fills schema defaults and reports sources", () => {
  const root = temp();
  const service = fakeService(root);
  const api = createSettingsApi({
    service,
    config: { dataDir: root },
    tools: ["bili_humanism_read"],
  });
  const state = api.state();
  assert.equal(state.values.maxReadTokens, DEFAULTS.maxReadTokens);
  assert.equal(state.values.shadowMaxReviewsPerDay, 2);
  assert.equal(state.sources.maxReadTokens, "default");
  assert.equal(state.sources.dataDir, "config");
  assert.deepEqual(state.status.tools, ["bili_humanism_read"]);
  assert.equal(state.status.daily.enabled, false);
  rmSync(root, { recursive: true, force: true });
});

test("enabling an account write needs the confirmation word", () => {
  const root = temp();
  const service = fakeService(root);
  const api = createSettingsApi({ service, config: { dataDir: root } });
  const rejected = api.save({ values: { enableLikeWrites: true } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "CONFIRM_REQUIRED");
  assert.equal(service.config.enableLikeWrites, false);
  assert.equal(existsSync(settingsFile({ dataDir: root })), false);

  const accepted = api.save({
    values: { enableLikeWrites: true },
    confirm: "开启写入",
  });
  assert.equal(accepted.status, 200);
  assert.ok(accepted.body.restart.includes("enableLikeWrites"));
  assert.equal(existsSync(settingsFile({ dataDir: root })), true);
  rmSync(root, { recursive: true, force: true });
});

test("save rejects invalid values without writing the overlay", () => {
  const root = temp();
  const service = fakeService(root);
  const api = createSettingsApi({ service, config: { dataDir: root } });
  const bad = api.save({ values: { maxReadTokens: 0, unknown: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "SETTINGS_INVALID");
  assert.ok(bad.body.errors.length >= 2);
  assert.equal(existsSync(settingsFile({ dataDir: root })), false);
  rmSync(root, { recursive: true, force: true });
});

test("clear removes the overlay and returns the file values", () => {
  const root = temp();
  const service = fakeService(root);
  const api = createSettingsApi({ service, config: { dataDir: root } });
  api.save({ values: { maxReadTokens: 12345 } });
  assert.equal(service.config.maxReadTokens, 12345);
  const cleared = api.clear();
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, true);
  assert.equal(service.config.maxReadTokens, DEFAULTS.maxReadTokens);
  assert.equal(loadSettings({ dataDir: root }).exists, false);
  rmSync(root, { recursive: true, force: true });
});

test("routes serve state, accept save bodies and guard methods", async () => {
  const root = temp();
  const service = fakeService(root);
  const api = createSettingsApi({ service, config: { dataDir: root } });
  const routes = [];
  registerSettingsRoutes({
    webServer: {
      register(route) {
        routes.push(route);
        return { dispose() {} };
      },
    },
    effect: (fn) => fn(),
    api,
  });
  assert.equal(routes.length, 4);
  assert.ok(routes.every((route) => route.path.startsWith(`${PREFIX}/`)));

  const state = routes.find((route) => route.path.endsWith("/state"));
  const read = await call(state);
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, true);

  const save = routes.find((route) => route.path.endsWith("/save"));
  const written = await call(save, {
    method: "POST",
    json: { values: { maxReadTokens: 4321 } },
  });
  assert.equal(written.status, 200);
  assert.equal(service.config.maxReadTokens, 4321);

  assert.equal((await call(save)).status, 405);
  assert.equal((await call(save, { method: "POST" })).status, 400);
  rmSync(root, { recursive: true, force: true });
});
