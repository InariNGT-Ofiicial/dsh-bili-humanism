import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Fault, need } from "./errors.mjs";
import { wbiKey } from "./wbi.mjs";
export const RESPONSE_BYTE_LIMITS = Object.freeze({
  media: 32 * 1024 * 1024,
  json: 4 * 1024 * 1024,
});
function responseTooLarge(kind, cap, observed, streamed = false) {
  const measured = Number.isSafeInteger(observed)
    ? `${streamed ? "at least " : ""}${observed} bytes`
    : "above the limit";
  return new Fault(
    "RESPONSE_TOO_LARGE",
    `${kind === "media" ? "Media" : "JSON"} response exceeds ${cap} bytes (${streamed ? "streamed" : "Content-Length"}: ${measured}); this is a response-byte limit, not a source-duration limit.`,
  );
}
const paths = new Set([
  "/x/web-interface/view",
  "/x/web-interface/nav",
  "/x/web-interface/view/conclusion/get",
  "/x/player/v2",
  "/x/player/wbi/v2",
  "/x/web-interface/popular",
  "/x/player/playurl",
]);
export function permitted(raw, kind = "api") {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Fault("URL_DENIED");
  }
  need(u.protocol === "https:" && !u.username && !u.password, "URL_DENIED");
  const standardPort = !u.port || u.port === "443";
  if (kind === "api")
    need(
      standardPort &&
        u.hostname === "api.bilibili.com" &&
        paths.has(u.pathname),
      "URL_DENIED",
    );
  else if (kind === "subtitle")
    need(
      standardPort &&
        (u.hostname === "aisubtitle.hdslb.com" ||
          u.hostname === "i0.hdslb.com") &&
        (/\.(json)$/.test(u.pathname) ||
          /^\/bfs\/ai_subtitle\//.test(u.pathname)),
      "URL_DENIED",
    );
  else if (kind === "media")
    need(
      (standardPort && /(^|\.)bilivideo\.com$/.test(u.hostname)) ||
        (u.hostname.endsWith(".mcdn.bilivideo.cn") &&
          (standardPort || u.port === "8082")),
      "URL_DENIED",
    );
  else throw new Fault("URL_DENIED");
  return u;
}
function credentialData(path) {
  if (!path) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    need(j.disabled !== true && j.read_valid !== false, "CREDENTIAL_DISABLED");
    need(
      typeof j.sessdata === "string" &&
        j.sessdata.length > 0 &&
        j.sessdata.length < 4096 &&
        !/[\r\n;]/.test(j.sessdata),
      "CREDENTIAL_INVALID",
    );
    return j;
  } catch {
    throw new Fault("CREDENTIAL_INVALID");
  }
}
export function credential(path) {
  return credentialData(path)?.sessdata ?? null;
}
export class Network {
  constructor(
    store,
    budget,
    { credentialPath = "", fetcher = globalThis.fetch } = {},
  ) {
    this.store = store;
    this.budget = budget;
    try {
      const data = credentialData(credentialPath);
      this.secret = data?.sessdata ?? null;
      this.device = data?.buvid3 ?? "";
      need(
        typeof this.device === "string" &&
          this.device.length <= 256 &&
          !/[\x00-\x20\x7f;]/.test(this.device),
        "CREDENTIAL_INVALID",
      );
    } catch (e) {
      store.pause("CREDENTIAL_INVALID");
      throw e;
    }
    this.fetcher = fetcher;
  }
  async get(raw, kind = "api") {
    const u = permitted(raw, kind);
    return this.request(u, kind);
  }
  // Internal transport. Public tools receive typed operations, never URLs/options.
  async request(
    u,
    kind,
    { method = "GET", body, csrf = "", device = "" } = {},
  ) {
    if (method === "POST") {
      need(
        kind === "api" &&
          u.origin === "https://api.bilibili.com" &&
          !u.username &&
          !u.password &&
          !u.search &&
          [
            "/x/v2/history/report",
            "/x/v3/fav/resource/deal",
            "/x/web-interface/archive/like",
            "/x/web-interface/coin/add",
          ].includes(u.pathname) &&
          typeof this.beforePost === "function",
        "URL_DENIED",
      );
    } else {
      need(method === "GET", "URL_DENIED");
      if (
        !(
          kind === "api" &&
          u.origin === "https://api.bilibili.com" &&
          !u.username &&
          !u.password &&
          [
            "/x/v3/fav/folder/created/list-all",
            "/x/web-interface/history/cursor",
            "/x/web-interface/archive/has/like",
            "/x/web-interface/archive/coins",
          ].includes(u.pathname) &&
          typeof this.guard === "function"
        )
      )
        permitted(u.href, kind);
    }
    const headers = {
      "User-Agent": "dsh-bili-humanism/1.7.1",
      Referer: "https://www.bilibili.com/",
    };
    const readDevice = method === "GET" ? this.device : "";
    if (kind === "api" && this.secret)
      headers.Cookie =
        "SESSDATA=" +
        this.secret +
        (csrf ? "; bili_jct=" + csrf : "") +
        (device || readDevice ? "; buvid3=" + (device || readDevice) : "");
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    let response;
    // Retry transport exceptions only. HTTP/API risk responses and POSTs never retry.
    const attempts = method === "GET" ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.budget.spend("requests");
      this.guard?.();
      if (method === "POST") this.beforePost?.();
      const signals = [
        AbortSignal.timeout(Math.min(15000, this.budget.remaining())),
        ...(this.budget.signal ? [this.budget.signal] : []),
      ];
      try {
        response = await this.fetcher(u, {
          method,
          ...(body ? { body: body.toString() } : {}),
          redirect: "manual",
          headers,
          signal: AbortSignal.any(signals),
        });
        break;
      } catch {
        this.budget.check();
        if (attempt + 1 === attempts) throw new Fault("NETWORK_FAILED");
        await delay(Math.min(150 * (attempt + 1), this.budget.remaining()));
      }
    }
    this.budget.check();
    if ([401, 403, 412, 429].includes(response.status)) {
      this.store.pause("HTTP_" + response.status);
      throw new Fault("PLATFORM_PAUSED");
    }
    need(response.status === 200, "HTTP_FAILED");
    const cap =
      kind === "media" ? RESPONSE_BYTE_LIMITS.media : RESPONSE_BYTE_LIMITS.json;
    const declared = Number(response.headers.get("content-length") || 0);
    if (!(declared <= cap)) throw responseTooLarge(kind, cap, declared);
    const chunks = [];
    let length = 0;
    try {
      for await (const part of response.body) {
        this.budget.check();
        length += part.length;
        if (length > cap) {
          await response.body.cancel().catch(() => {});
          throw responseTooLarge(kind, cap, length, true);
        }
        chunks.push(part);
      }
    } catch (e) {
      if (e instanceof Fault) throw e;
      this.budget.check();
      throw new Fault("BODY_READ_FAILED");
    }
    const data = Buffer.concat(chunks);
    if (kind === "media") return data;
    let j;
    try {
      j = JSON.parse(data.toString("utf8"));
    } catch {
      if (
        /captcha|验证码|验证页面/i.test(data.toString("utf8").slice(0, 8192))
      ) {
        this.store.pause("NON_JSON_CHALLENGE");
        throw new Fault("PLATFORM_PAUSED");
      }
      throw new Fault("INVALID_RESPONSE");
    }
    if (
      kind === "api" &&
      (j.data?.v_voucher ||
        /captcha|验证码|风控|账号异常/i.test(String(j.message || "")))
    ) {
      this.store.pause("API_CHALLENGE");
      throw new Fault("PLATFORM_PAUSED");
    }
    // Anonymous nav may return public WBI keys alongside "not logged in".
    // Only this exact GET with valid keys is usable; credentialed -101, player
    // -101, HTTP failures and challenge responses retain their risk handling.
    const publicWbiNav =
      kind === "api" &&
      method === "GET" &&
      !this.secret &&
      u.pathname === "/x/web-interface/nav" &&
      !u.search &&
      j.code === -101 &&
      j.data?.isLogin === false &&
      wbiKey(j.data?.wbi_img) !== null;
    if (kind === "api" && j.code !== 0 && !publicWbiNav) {
      if ([-101, -111, -352, -412, -509, -403].includes(j.code)) {
        this.store.pause("API_" + j.code);
        throw new Fault(
          j.code === -101 ? "CREDENTIAL_EXPIRED" : "PLATFORM_PAUSED",
        );
      }
      throw new Fault(
        "API_UNAVAILABLE",
        this.secret
          ? "API_UNAVAILABLE"
          : "Platform API returned an unavailable result. No read credential was loaded. If this source needs login, configure credentialPath in the trusted plugin config; for the standalone CLI set BILI_HUMANISM_CREDENTIAL_FILE or credentialPath in BILI_HUMANISM_CONFIG_FILE. CLI does not automatically load the DSH profile. Missing credentials do not establish the cause of this API failure.",
      );
    }
    return j;
  }
}
