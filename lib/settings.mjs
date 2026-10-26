// Local settings overlay for the human-facing settings page.
//
// The trusted source of configuration is still the profile's cordis.patch.yml.
// This module keeps a small, human-edited JSON layer at
// `<dataDir>/settings.json` (default `~/.dsh/bili-humanism/settings.json`) that
// wins over the patch for the keys the human saved there. Deleting the file
// returns every key to the patch value. Only a fixed whitelist of Config keys
// is accepted; model tools can never reach this file.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { dailyConfig } from "./daily-fetch.mjs";

export const FILE_NAME = "settings.json";
export const MAX_TEXT = 4000;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const WRITE_KEYS = [
  "enableHistoryWrites",
  "enableFavoriteWrites",
  "enableLikeWrites",
  "enableCoinWrites",
];

export const PATH_KEYS = ["pythonPath", "asrModelPath"];
export const TEXT_KEYS = [
  "dataDir",
  "credentialPath",
  ...PATH_KEYS,
  "writePolicyPath",
  "accountStateDir",
];
export const BOOLEAN_KEYS = [
  ...WRITE_KEYS,
  "enablePersonalityLearning",
  "enablePersonalityShadow",
  "enableDailyFetching",
];
export const NUMBER_KEYS = ["maxReadTokens", "maxSessionTokens"];
export const SETTINGS_KEYS = [
  ...TEXT_KEYS,
  ...BOOLEAN_KEYS,
  ...NUMBER_KEYS,
  "maxMediaSeconds",
  "dailyFetchStart",
  "dailyFetchEnd",
  "dailyFetchLimit",
  "shadowMaxReviewsPerDay",
];

// Keys whose change can be pushed into the running Service immediately.
export const IMMEDIATE_KEYS = [
  "maxReadTokens",
  "maxSessionTokens",
  "pythonPath",
  "asrModelPath",
  "credentialPath",
  "writePolicyPath",
  "accountStateDir",
];

// Mirrors the Config schema defaults in index.js. Used only for the "source"
// hint in the settings page and for showing what a cleared overlay would mean;
// the runtime values always come from cordis and this overlay.
export const DEFAULTS = {
  dataDir: "",
  credentialPath: "",
  pythonPath: "",
  asrModelPath: "",
  maxMediaSeconds: null,
  maxReadTokens: 600000,
  maxSessionTokens: 600000,
  enableHistoryWrites: false,
  enableFavoriteWrites: false,
  enableLikeWrites: false,
  enableCoinWrites: false,
  writePolicyPath: "",
  accountStateDir: "",
  enablePersonalityLearning: true,
  enablePersonalityShadow: false,
  shadowMaxReviewsPerDay: 2,
  enableDailyFetching: false,
  dailyFetchStart: "21:30",
  dailyFetchEnd: "22:00",
  dailyFetchLimit: 2,
};

export function baseDir(config = {}) {
  return (
    config.dataDir ||
    join(process.env.DSH_HOME || join(homedir(), ".dsh"), "bili-humanism")
  );
}

export function settingsFile(config = {}) {
  return join(baseDir(config), FILE_NAME);
}

function textFault(value) {
  return (
    typeof value !== "string" ||
    value.length > MAX_TEXT ||
    value.includes("\0")
  );
}

export function validateSettings(input) {
  const errors = [];
  const values = {};
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { values, errors: ["SETTINGS_INVALID"] };
  for (const [key, value] of Object.entries(input)) {
    if (!SETTINGS_KEYS.includes(key)) {
      errors.push(`unknown:${key}`);
      continue;
    }
    if (TEXT_KEYS.includes(key)) {
      if (textFault(value)) {
        errors.push(`${key}:text`);
        continue;
      }
      if (PATH_KEYS.includes(key) && value !== "" && !isAbsolute(value)) {
        errors.push(`${key}:absolute`);
        continue;
      }
      values[key] = value;
      continue;
    }
    if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value !== "boolean") {
        errors.push(`${key}:boolean`);
        continue;
      }
      values[key] = value;
      continue;
    }
    if (key === "maxMediaSeconds") {
      if (value === null) {
        values[key] = null;
        continue;
      }
      if (!Number.isSafeInteger(value) || value < 1) {
        errors.push(`${key}:positive`);
        continue;
      }
      values[key] = value;
      continue;
    }
    if (key === "dailyFetchLimit") {
      if (value !== 1 && value !== 2) {
        errors.push(`${key}:limit`);
        continue;
      }
      values[key] = value;
      continue;
    }
    if (key === "shadowMaxReviewsPerDay") {
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        errors.push(`${key}:range`);
        continue;
      }
      values[key] = value;
      continue;
    }
    if (key === "dailyFetchStart" || key === "dailyFetchEnd") {
      if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
        errors.push(`${key}:time`);
        continue;
      }
      values[key] = value;
      continue;
    }
    if (value === null || value === undefined || value === "") {
      errors.push(`${key}:empty`);
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
      errors.push(`${key}:integer`);
      continue;
    }
    values[key] = value;
  }
  if (
    values.dailyFetchStart !== undefined &&
    values.dailyFetchEnd !== undefined &&
    !(values.dailyFetchEnd > values.dailyFetchStart)
  )
    errors.push("dailyFetch:order");
  return { values, errors };
}

export function loadSettings(config = {}) {
  const file = settingsFile(config);
  const out = { file, exists: false, values: {}, error: null, updatedAt: null };
  if (!existsSync(file)) return out;
  out.exists = true;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const source =
      raw && typeof raw === "object" && raw.values && typeof raw.values === "object"
        ? raw.values
        : raw;
    const checked = validateSettings(source || {});
    out.values = checked.values;
    out.updatedAt =
      raw && typeof raw === "object" && typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : null;
    if (checked.errors.length) out.error = checked.errors.join(",");
  } catch {
    out.error = "SETTINGS_UNREADABLE";
  }
  return out;
}

export function mergeSettings(config = {}, values = {}) {
  const merged = { ...config };
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export function computeSources(merged = {}, config = {}, overrides = {}) {
  const sources = {};
  for (const key of SETTINGS_KEYS) {
    if (Object.hasOwn(overrides, key)) sources[key] = "settings";
    else if (Object.hasOwn(config, key) && config[key] !== DEFAULTS[key])
      sources[key] = "config";
    else sources[key] = "default";
  }
  return sources;
}

export function writeSettings(config = {}, values = {}) {
  const file = settingsFile(config);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    note: "Human-edited settings overlay for dsh-bili-humanism. Delete this file to fall back to the profile's cordis.patch.yml. Model tools never read or write it.",
    values,
  };
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
  return file;
}

export function clearSettings(config = {}) {
  const file = settingsFile(config);
  if (!existsSync(file)) return false;
  copyFileSync(file, `${file}.bak`);
  rmSync(file, { force: true });
  return true;
}

export function fileFacts(path) {
  if (typeof path !== "string" || path === "")
    return { path: "", exists: false, size: null };
  try {
    const stat = statSync(path);
    return { path, exists: true, size: stat.size };
  } catch {
    return { path, exists: false, size: null };
  }
}

// Push the merged config into the running Service. Fields read at call time
// change immediately; tool registration and the ledger root cannot, so those
// keys are reported back as requiring a restart.
export function applyLive(service, merged) {
  const applied = [];
  const restart = [];
  const config = service.config;
  const tokens =
    merged.maxReadTokens ?? merged.maxSessionTokens ?? DEFAULTS.maxReadTokens;
  if (config.maxReadTokens !== tokens) {
    config.maxReadTokens = tokens;
    applied.push("maxReadTokens");
  }
  if (config.maxSessionTokens !== (merged.maxSessionTokens ?? DEFAULTS.maxSessionTokens)) {
    config.maxSessionTokens = merged.maxSessionTokens ?? DEFAULTS.maxSessionTokens;
    applied.push("maxSessionTokens");
  }
  for (const key of IMMEDIATE_KEYS) {
    if (key === "maxReadTokens" || key === "maxSessionTokens") continue;
    const value = merged[key] ?? DEFAULTS[key];
    if (config[key] === value) continue;
    config[key] = value;
    applied.push(key);
  }
  const media = merged.maxMediaSeconds;
  if (media !== config.maxMediaSeconds) {
    if (media === undefined || media === null) {
      delete config.maxMediaSeconds;
      service.limits.asrSeconds = Number.MAX_SAFE_INTEGER;
    } else {
      config.maxMediaSeconds = media;
      service.limits.asrSeconds = media;
    }
    applied.push("maxMediaSeconds");
  }
  for (const key of WRITE_KEYS) {
    const want = merged[key] === true;
    if ((config[key] === true) === want) continue;
    config[key] = want;
    if (want) restart.push(key);
    else applied.push(key);
  }
  const personality = merged.enablePersonalityLearning !== false;
  if ((config.enablePersonalityLearning === true) !== personality) {
    config.enablePersonalityLearning = personality;
    if (personality) restart.push("enablePersonalityLearning");
    else applied.push("enablePersonalityLearning");
  }
  // The experimental shadow tool is registered during apply(), so any change
  // to the flag only fully takes effect after a reload/restart.
  const shadow = merged.enablePersonalityShadow === true;
  if ((config.enablePersonalityShadow === true) !== shadow) {
    config.enablePersonalityShadow = shadow;
    restart.push("enablePersonalityShadow");
  }
  if (
    config.shadowMaxReviewsPerDay !==
    (merged.shadowMaxReviewsPerDay ?? DEFAULTS.shadowMaxReviewsPerDay)
  ) {
    config.shadowMaxReviewsPerDay =
      merged.shadowMaxReviewsPerDay ?? DEFAULTS.shadowMaxReviewsPerDay;
    applied.push("shadowMaxReviewsPerDay");
  }
  const fetcher = service.dailyFetcher;
  if (fetcher) {
    let next = null;
    try {
      next = dailyConfig(merged);
    } catch {
      restart.push("dailyFetch");
    }
    if (next) {
      const changed =
        fetcher.config.enabled !== next.enabled ||
        fetcher.config.start !== next.start ||
        fetcher.config.end !== next.end ||
        fetcher.config.limit !== next.limit;
      fetcher.config = next;
      if (changed) {
        fetcher.stop();
        fetcher.start();
        applied.push("dailyFetch");
      }
    }
  }
  return { applied, restart };
}
