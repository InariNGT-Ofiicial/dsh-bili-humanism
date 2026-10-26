// HTTP surface behind the settings page. The page never touches files directly:
// it reads one snapshot and posts validated values back, and the host applies
// them to the running Service.
//
// These routes are local-only helpers for a human in the DSH desktop window.
// They are not model tools, and the overlay they write is not a platform grant:
// account writes still require the trusted policy file, a device cookie and a
// human-confirmed receipt at call time.
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULTS,
  WRITE_KEYS,
  applyLive,
  clearSettings,
  computeSources,
  fileFacts,
  loadSettings,
  mergeSettings,
  settingsFile,
  validateSettings,
  writeSettings,
} from "./settings.mjs";

export const PREFIX = "/dsh-bili-humanism/settings";
export const CONFIRM_WORD = "开启写入";
const BODY_LIMIT = 1024 * 1024;

function send(res, status, payload) {
  if (!res || res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) return { error: "BODY_TOO_LARGE" };
    chunks.push(chunk);
  }
  if (!chunks.length) return { value: {} };
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return { error: "BODY_INVALID" };
    return { value };
  } catch {
    return { error: "BODY_INVALID" };
  }
}

function pathFacts(value) {
  const facts = fileFacts(value);
  if (!facts.exists) return facts;
  try {
    const stat = statSync(facts.path);
    return { ...facts, isDirectory: stat.isDirectory(), isFile: stat.isFile() };
  } catch {
    return facts;
  }
}

export function createSettingsApi({ service, config = {}, defaults = DEFAULTS, tools = [] }) {
  const snapshot = () => {
    const loaded = loadSettings(config);
    return { loaded, merged: mergeSettings(config, loaded.values) };
  };

  const state = () => {
    const { loaded, merged } = snapshot();
    return {
      ok: true,
      file: {
        path: settingsFile(config),
        exists: loaded.exists,
        error: loaded.error,
        updatedAt: loaded.updatedAt,
      },
      // Fill schema defaults that cordis leaves absent (for example
      // maxReadTokens, which has no .default() and only the runtime fallback),
      // so the page shows the effective value instead of an empty box.
      values: { ...defaults, ...merged },
      overrides: loaded.values,
      sources: computeSources(merged, config, loaded.values),
      defaults,
      confirmWord: CONFIRM_WORD,
      status: {
        dataDir: service.store.root,
        ledger: fileFacts(join(service.store.root, "ledger.sqlite")),
        credential: pathFacts(merged.credentialPath),
        writePolicy: pathFacts(merged.writePolicyPath),
        daily:
          typeof service.dailyFetcher?.status === "function"
            ? service.dailyFetcher.status()
            : null,
        tools,
      },
    };
  };

  const restartAfter = (merged, live) => {
    const restart = [...live.restart];
    if ((merged.dataDir || "") !== (service.config.dataDir || ""))
      restart.push("dataDir");
    return { applied: live.applied, restart: [...new Set(restart)] };
  };

  const save = (body = {}) => {
    const checked = validateSettings(body.values || {});
    if (checked.errors.length)
      return {
        status: 400,
        body: { ok: false, error: "SETTINGS_INVALID", errors: checked.errors },
      };
    if (Object.keys(checked.values).length === 0)
      return { status: 400, body: { ok: false, error: "SETTINGS_EMPTY" } };
    const { loaded } = snapshot();
    const next = { ...loaded.values, ...checked.values };
    const merged = mergeSettings(config, next);
    const turningOn = WRITE_KEYS.filter(
      (key) => merged[key] === true && service.config[key] !== true,
    );
    if (turningOn.length && body.confirm !== CONFIRM_WORD)
      return {
        status: 400,
        body: {
          ok: false,
          error: "CONFIRM_REQUIRED",
          fields: turningOn,
          need: CONFIRM_WORD,
        },
      };
    writeSettings(config, next);
    const live = applyLive(service, merged);
    return {
      status: 200,
      body: {
        ok: true,
        ...restartAfter(merged, live),
        file: settingsFile(config),
      },
    };
  };

  const clear = () => {
    const existed = clearSettings(config);
    const merged = mergeSettings(config, {});
    const live = applyLive(service, merged);
    return {
      status: 200,
      body: { ok: true, cleared: existed, ...restartAfter(merged, live) },
    };
  };

  const check = (body = {}) => ({
    status: 200,
    body: { ok: true, ...pathFacts(body.path) },
  });

  return { state, save, clear, check };
}

export function registerSettingsRoutes({
  webServer,
  effect = (fn) => fn(),
  api,
}) {
  if (!webServer || typeof webServer.register !== "function") return [];
  const routes = [];
  const route = (method, path, handler) => {
    const registered = effect(() =>
      webServer.register({
        kind: "exact",
        path: PREFIX + path,
        handler: async (req, res) => {
          try {
            if ((req.method || "GET").toUpperCase() !== method)
              return send(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
            const result = await handler(req, res);
            if (result) send(res, result.status ?? 200, result.body);
          } catch {
            send(res, 500, { ok: false, error: "SETTINGS_ROUTE_FAILED" });
          }
        },
      }),
    );
    routes.push(registered);
    return registered;
  };

  route("GET", "/state", () => ({ status: 200, body: api.state() }));
  route("POST", "/save", async (req) => {
    const parsed = await readJson(req);
    if (parsed.error) return { status: 400, body: { ok: false, error: parsed.error } };
    return api.save(parsed.value);
  });
  route("POST", "/clear", () => api.clear());
  route("POST", "/check", async (req) => {
    const parsed = await readJson(req);
    if (parsed.error) return { status: 400, body: { ok: false, error: parsed.error } };
    return api.check(parsed.value);
  });
  return routes;
}
