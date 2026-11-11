import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  lstatSync,
  existsSync,
  rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store, atomic } from "./store.mjs";
import {
  runTextProbe,
  runAudioProbe,
  summarizeProbe,
  probeNames,
  probeSpeechSeconds,
} from "./quality.mjs";
import { Budget } from "./budget.mjs";
import { DailyFetcher, dailyConfig } from "./daily-fetch.mjs";
import { PersonalityShadow } from "./personality-shadow.mjs";
import { PostViewingQuestion } from "./post-viewing-question.mjs";
import {
  pythonFor,
  modelFor,
  mediaEnvironmentStatus,
} from "./media-environment.mjs";
import { Network, RESPONSE_BYTE_LIMITS } from "./network.mjs";
import { readVideo, candidates, coverage, segments } from "./reader.mjs";
import { scanDanmakuXml, summarize, peaks, fitEntries } from "./danmaku.mjs";
import { Fault, need, safeError } from "./errors.mjs";
import {
  temporaryVideo,
  videoTrack,
  audioTrack,
  firstMediaBytes,
  cleanupVideo,
  inside,
  noLinks,
  boundedFrameBytes,
  spreadOrder,
  chosenTimes,
} from "./visual-media.mjs";
import { VISUAL_PAGE_SIZE } from "./visual-output.mjs";
import { Writer, grant, writeStatus, confirmConsumption } from "./writer.mjs";
import {
  personality,
  queuePersonalityReview,
  continuePersonalityReview,
  personalityReviewStatus,
} from "./personality.mjs";
import {
  readTokenLimit,
  checkReadTokenBudget,
  READ_TOKEN_ESTIMATE,
} from "./token-gate.mjs";
import { fields, exportInbox, readInbox, verifyInbox } from "./inbox.mjs";
import {
  enforceJournalDailyLimit,
  journalDailyStatus,
} from "./journal-policy.mjs";
const defaultLimits = {
  requests: 12,
  candidates: 3,
  asrSeconds: Number.MAX_SAFE_INTEGER,
  wallMs: null,
};
export function text(value, max = 12000) {
  need(typeof value === "string" && value.length <= max, "INVALID_TEXT");
  return value.trim();
}
export function noteBody(raw, reading) {
  need(raw && typeof raw === "object" && !Array.isArray(raw), "INVALID_NOTE");
  need(
    Object.keys(raw).every((k) => fields.includes(k) || k === "evidence"),
    "INVALID_NOTE_FIELD",
  );
  const body = Object.fromEntries(fields.map((k) => [k, text(raw[k] || "")]));
  need(body.encounter && body.missing, "NOTE_REQUIRES_ENCOUNTER_AND_LIMITS");
  need(
    Array.isArray(raw.evidence) && raw.evidence.length <= 20,
    "INVALID_EVIDENCE",
  );
  body.evidence = raw.evidence.map((e) => {
    need(
      Number.isFinite(e.at) && e.at >= 0 && e.at <= reading.duration,
      "INVALID_EVIDENCE_TIME",
    );
    return {
      at: e.at,
      claim: text(e.claim, 2000),
      url: reading.url + "&t=" + Math.floor(e.at),
    };
  });
  if (body.facts || body.author_view)
    need(body.evidence.length > 0, "EVIDENCE_REQUIRED");
  return body;
}
const danmakuItems = (entry) =>
  entry.rows.map(([t, text, weight]) => ({ t, text, weight }));
const clip = (value, limit) => [...value].slice(0, limit).join("");
const textCharacters = (segs) =>
  segs.reduce(
    (total, { text }) => total + [...text.replace(/\s/gu, "")].length,
    0,
  );
const validOrder = (order, count) =>
  Array.isArray(order) &&
  order.length === count &&
  new Set(order).size === count &&
  order.every(
    (index) => Number.isInteger(index) && index >= 0 && index < count,
  );
// Little or no speech text. A short clip may simply stop talking early, and A3 text
// has already been through ASR.
function missingSpeech(reading) {
  if (reading.route === "none") return true;
  if (reading.route === "A3" || !(reading.duration >= 60)) return false;
  const last = reading.segments.reduce(
    (end, { start, end: stop }) => Math.max(end, stop ?? start),
    0,
  );
  return last < reading.duration * 0.5;
}
// What a read fetched, kept beside a saved transcript it shows instead.
const networkSource = ({
  route,
  cached,
  attempts,
  subtitleSource,
  coverage: covered,
}) => ({ route, cached, attempts, subtitleSource, coverage: covered });
const isAutoAttempt = ({ route, state }) =>
  route === "A3" && /^auto_/.test(state);
// The entry on a reading, without what is kept only to decide about running again.
const autoAttempt = ({ route, state, error, mediaCleanup }) => ({
  route,
  state,
  ...(error ? { error } : {}),
  ...(mediaCleanup ? { mediaCleanup } : {}),
});
export const autoAsrFailure = (error) =>
  autoAttempt({ route: "A3", state: "auto_unavailable", ...safeError(error) });
// A crash may be the video or a broken environment; the doctor does not load the model.
const AUTO_ASR_FAILED_RUNS = 3;
// The title is untrusted and only ever a hint to the speech model.
const asrTitle = (title) =>
  clip(
    String(title ?? "")
      .replace(/\p{Cc}/gu, "")
      .trim(),
    120,
  );
// When a human sets a task wall, decoding shares it with the text. It must give up
// first, so that running out of time costs the images and not the reading already saved.
const VISUAL_WALL_MARGIN_SECONDS = 5;
const distinctTimes = (at) => [...new Set(at)].sort((a, b) => a - b);
export class Service {
  constructor(config = {}, dependencies = {}) {
    dailyConfig(config);
    need(
      config.pythonPath === undefined ||
        (typeof config.pythonPath === "string" &&
          (!config.pythonPath || isAbsolute(config.pythonPath))),
      "INVALID_PYTHON_PATH",
    );
    const maxMediaSeconds = config.maxMediaSeconds ?? undefined;
    const wallMs = config.limits?.wallMs ?? null;
    need(
      wallMs === null ||
        (Number.isSafeInteger(wallMs) && wallMs >= 0 && wallMs <= 2147483647),
      "INVALID_LIMIT",
    );
    need(
      config.asrModelPath === undefined ||
        (typeof config.asrModelPath === "string" &&
          (!config.asrModelPath || isAbsolute(config.asrModelPath))),
      "INVALID_ASR_MODEL_PATH",
    );
    need(
      maxMediaSeconds === undefined ||
        (Number.isSafeInteger(maxMediaSeconds) && maxMediaSeconds > 0),
      "INVALID_MEDIA_SECONDS",
    );
    const autoAsrMaxSeconds = config.autoAsrMaxSeconds ?? 1200,
      autoAsrWallMs = config.autoAsrWallMs ?? 240000;
    need(
      [undefined, null, true, false].includes(config.autoAsr) &&
        Number.isSafeInteger(autoAsrMaxSeconds) &&
        autoAsrMaxSeconds > 0 &&
        Number.isSafeInteger(autoAsrWallMs) &&
        autoAsrWallMs > 0,
      "INVALID_AUTO_ASR",
    );
    this.config = {
      ...config,
      maxReadTokens: readTokenLimit(config),
      maxMediaSeconds,
      autoAsr: config.autoAsr ?? false,
      autoAsrMaxSeconds,
      autoAsrWallMs,
      enablePersonalityLearning:
        config.enablePersonalityLearning === undefined
          ? true
          : config.enablePersonalityLearning,
    };
    this.store = new Store(
      config.dataDir ||
        join(process.env.DSH_HOME || join(homedir(), ".dsh"), "bili-humanism"),
    );
    this.limits = {
      ...defaultLimits,
      asrSeconds: maxMediaSeconds ?? defaultLimits.asrSeconds,
      ...config.limits,
      wallMs,
    };
    for (const key of Object.keys(defaultLimits).filter(
      (key) => key !== "wallMs",
    ))
      need(
        Number.isFinite(this.limits[key]) &&
          this.limits[key] >= 0 &&
          this.limits[key] <=
            (key === "asrSeconds"
              ? (maxMediaSeconds ?? defaultLimits.asrSeconds)
              : defaultLimits[key]),
        "INVALID_LIMIT",
      );
    this.fetcher = dependencies.fetcher || globalThis.fetch;
    this.personalityClock = dependencies.personality?.now;
    this.questions = new PostViewingQuestion(
      this.store,
      this.config,
      dependencies.questions?.now,
    );
    this.shadow = new PersonalityShadow(
      this.store,
      this.config,
      dependencies.shadow?.now,
    );
    this.spawn = dependencies.spawn || spawn;
    this.active = new Set();
    this.dailyFetcher = new DailyFetcher(this, dependencies.daily);
  }
  async task(fn, signal, limits = this.limits) {
    const id = this.store.start();
    const controller = new AbortController();
    this.active.add(controller);
    const budget = new Budget(
      this.store,
      id,
      limits,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    );
    try {
      const network = new Network(this.store, budget, {
        credentialPath: this.config.credentialPath,
        fetcher: this.fetcher,
      });
      const result = await fn(network, budget);
      budget.check();
      this.store.finish(id, "completed");
      return {
        taskId: id,
        result,
        usage: {
          requests: budget.requests,
          candidates: budget.candidates,
          asr_seconds: budget.asr,
          elapsed_ms: Date.now() - budget.started,
          tokens: null,
        },
      };
    } catch (e) {
      this.store.finish(
        id,
        e.code === "CANCELLED" ? "cancelled" : "failed",
        e.code || "INTERNAL_ERROR",
      );
      throw e;
    } finally {
      this.active.delete(controller);
      if (this.closing && this.active.size === 0) this.store.close();
    }
  }
  /**
   * Offline quality probes over an already stored text source. No network request, no model call,
   * no credential use: this only reads the ledger and computes statistics in a local process.
   */
  async probe(readingId, options = {}) {
    const reading = this.store.reading(readingId);
    need(
      Array.isArray(reading.segments) && reading.segments.length > 0,
      "READING_HAS_NO_TEXT",
    );
    const names = probeNames(options.names);
    let speechSeconds = probeSpeechSeconds(
      options.speechSeconds,
      reading.duration,
    );
    let audio = null;
    if (options.audioFile) {
      audio = await this.audioProbe(options.audioFile, options.audioOptions);
      if (!speechSeconds) {
        speechSeconds = probeSpeechSeconds(
          Math.min(audio.speechSeconds, reading.duration),
          reading.duration,
        );
      }
    }
    const raw = await runTextProbe({
      python: pythonFor(this.config, this.store.root),
      workDir: join(this.store.root, "tmp"),
      reading,
      names,
      speechSeconds,
      duration: reading.duration,
    });
    if (audio) raw.audio = audio;
    return summarizeProbe(raw);
  }
  /** Local CLI only: the operator names the media file explicitly. */
  async audioProbe(file, options = {}) {
    need(
      typeof file === "string" && isAbsolute(file) && existsSync(file),
      "AUDIO_PROBE_PATH_INVALID",
    );
    return runAudioProbe({
      python: pythonFor(this.config, this.store.root),
      file,
      workDir: join(this.store.root, "tmp"),
      ...options,
    });
  }
  async read(input, page, signal) {
    return this.task(
      (network) => this.readSource(input, page, network),
      signal,
    );
  }
  async readSource(input, page, network) {
    const reading = await readVideo(input, page, network, this.store);
    const local = !reading.segments.length
      ? this.store.localTranscript(reading)
      : null;
    const selected = local
      ? {
          ...local,
          cached: reading.cached,
          deduplicated: true,
          reusedLocalSource: true,
          networkSource: networkSource(reading),
        }
      : reading;
    const tokenBudget = this.sourceTokenBudget(selected);
    return {
      ...(local ? selected : this.store.saveReading(selected)),
      tokenBudget,
    };
  }
  async readVisual(input, page, signal) {
    return this.task(async (network, budget) => {
      const reading = await this.readSource(input, page, network);
      try {
        budget.check();
        const key = "visual:" + reading.id;
        // An order not chosen yet waits for danmaku here too: see readFrames.
        const visual = this.store.getControl(key)
          ? this.framePage(key, reading.id, 0, false)
          : await this.prepareVisual(reading, network, budget, null, false);
        return { ...reading, visual: { status: "sampled_frames", ...visual } };
      } catch (error) {
        if (
          [
            "CANCELLED",
            "WALL_BUDGET",
            "PERSISTENT_PAUSE",
            "PLATFORM_PAUSED",
            "CREDENTIAL_INVALID",
            "CREDENTIAL_EXPIRED",
            "REQUESTS_BUDGET",
            "CANDIDATES_BUDGET",
          ].includes(error.code)
        )
          throw error;
        return {
          ...reading,
          visual: {
            status: "unavailable",
            ...safeError(error),
            note: "No video images were delivered; text does not establish visual understanding.",
          },
        };
      }
    }, signal);
  }
  async candidates(count = 3, signal) {
    return this.task((network) => candidates(network, count), signal);
  }
  /**
   * Viewer reactions for a saved reading, fetched at most once. An answered fetch is
   * cached even when empty; a failed one is not, so a later call may retry. The text does
   * not depend on it. Daily fetching never calls it.
   */
  async danmaku(readingId, signal) {
    try {
      if (signal?.aborted) throw new Fault("CANCELLED");
      const reading = this.store.reading(readingId);
      const key = "danmaku:" + readingId;
      const entry =
        this.store.getControl(key) ??
        (
          await this.task(async (network, budget) => {
            const xml = await network.get(
              `https://api.bilibili.com/x/v1/dm/list.so?oid=${reading.cid}`,
              "danmaku",
            );
            budget.check();
            const { total, items } = scanDanmakuXml(xml, reading.duration);
            const fetched = {
              total,
              rows: items.map(({ t, text, weight }) => [t, text, weight]),
            };
            this.store.setControl(key, fetched);
            return fetched;
          }, signal)
        ).result;
      const items = danmakuItems(entry);
      return {
        status: "ready",
        total: entry.total,
        kept: items.length,
        top: summarize(items, -Infinity, Infinity),
        peaks: peaks(items, reading.duration),
      };
    } catch (error) {
      // CREDENTIAL_INVALID has just set the persistent pause in the Network constructor.
      if (
        [
          "CANCELLED",
          "PERSISTENT_PAUSE",
          "PLATFORM_PAUSED",
          "CREDENTIAL_INVALID",
        ].includes(error.code)
      )
        throw error;
      return { status: "unavailable", error: safeError(error).error };
    }
  }
  /** Cache only, never the network: empty until danmaku() has answered once. */
  danmakuAround(readingId, at, seconds = 5, top = 5) {
    const entry = this.store.getControl("danmaku:" + readingId);
    return entry
      ? summarize(danmakuItems(entry), at - seconds, at + seconds, top)
      : [];
  }
  /** What was said and how viewers reacted around a moment. Cache only, never the network. */
  frameContext(readingId, at) {
    const near = this.store
      .reading(readingId)
      .segments.filter(
        ({ start, end }) => start <= at + 4 && (end ?? start) >= at - 4,
      );
    return {
      said: clip(near.map(({ text }) => text).join(" "), 100),
      danmaku: fitEntries(this.danmakuAround(readingId, at), 80),
    };
  }
  status() {
    const writes = writeStatus(this.config);
    return {
      ...this.store.status(),
      scheduled: this.dailyFetcher.running,
      dailyFetching: this.dailyFetcher.status(),
      tokens: {
        kind: "estimated_source_tokens",
        scope: "per_transcript",
        limit: this.config.maxReadTokens,
        estimate: READ_TOKEN_ESTIMATE,
        lastAttempt: this.store.getControl("read-token-status"),
        note: "One UTF-8 source text byte counts as one estimated token. Each transcript is independent; provider session totals are not used. Not a model context or billing cap.",
      },
      journals: journalDailyStatus(this.store),
      personalityLearning: personalityReviewStatus(
        this.store,
        this.config.enablePersonalityLearning,
        this.personalityClock,
      ),
      personalityShadow: this.shadow.status(),
      postViewingQuestions: this.questions.status(),
      media: {
        environment: mediaEnvironmentStatus(this.config, this.store.root),
        mediaResponseBytes: RESPONSE_BYTE_LIMITS.media,
        jsonResponseBytes: RESPONSE_BYTE_LIMITS.json,
        taskRequests: this.limits.requests,
        taskWallMs: this.limits.wallMs,
        maxSourceSeconds:
          this.config.maxMediaSeconds === undefined &&
          this.config.limits?.asrSeconds === undefined
            ? null
            : this.limits.asrSeconds,
        autoAsr: {
          enabled: this.config.autoAsr,
          maxSeconds: this.config.autoAsrMaxSeconds,
          wallMs: this.config.autoAsrWallMs,
        },
        note: "No fixed source-duration limit by default. Request, byte and frame-count budgets still apply. No task wall-time limit by default; a human may set limits.wallMs or maxMediaSeconds. Sampled frames do not establish complete viewing.",
      },
      platformWriteTools: writes.platformWriteTools,
      writes,
    };
  }
  async platformWrite(kind, args, signal) {
    need(
      ["history", "favorites", "likes", "coins"].includes(kind),
      "WRITE_SCOPE_DENIED",
    );
    grant(this.config, kind);
    return this.task(
      (network) => new Writer(this.config, this.store, network).run(kind, args),
      signal,
    );
  }
  confirmConsumption(readingId, seconds) {
    return confirmConsumption(this.store, readingId, seconds);
  }
  sourceTokenBudget(reading) {
    return checkReadTokenBudget(
      this.store,
      reading.segments,
      this.config.maxReadTokens,
    );
  }
  personality(action, args = {}) {
    return personality(
      this.store,
      action,
      args,
      this.config.enablePersonalityLearning === true,
      this.personalityClock,
    );
  }
  continuePersonalityReview(journalId, exec) {
    return continuePersonalityReview(
      this.store,
      journalId,
      this.config.enablePersonalityLearning,
      exec,
    );
  }
  journal(readingId, raw) {
    const reading = this.store.reading(readingId);
    const body = noteBody(raw, reading);
    return this.store.tx(() => {
      const existing = this.store.db
        .prepare(
          "SELECT id FROM notes WHERE reading_id=? AND body=? ORDER BY created,id LIMIT 1",
        )
        .get(readingId, JSON.stringify(body));
      if (existing) {
        verifyInbox(this.store);
        return {
          id: existing.id,
          readingId,
          status: "local_reviewable_draft",
          path: join(this.store.root, "inbox.md"),
          deduplicated: true,
          question: this.questions.existing(existing.id),
          personality: queuePersonalityReview(
            this.store,
            existing.id,
            this.config.enablePersonalityLearning,
            this.personalityClock,
          ),
        };
      }
      const created = new Date().toISOString();
      enforceJournalDailyLimit(this.store, created);
      if (this.store.getControl("inbox:index-hash")) verifyInbox(this.store);
      const id = this.store.note(readingId, body, created);
      const review = queuePersonalityReview(
        this.store,
        id,
        this.config.enablePersonalityLearning,
        this.personalityClock,
      );
      const question = this.questions.queue(id);
      const path = exportInbox(this.store);
      return {
        id,
        readingId,
        status: "local_reviewable_draft",
        path,
        deduplicated: false,
        personality: review,
        question,
      };
    });
  }
  inbox(args = {}) {
    return readInbox(this.store, args);
  }
  exportInbox() {
    return this.store.tx(() => exportInbox(this.store));
  }
  importLocal(readingId, raw) {
    return this.task(async (_network, budget) => {
      const r = this.store.reading(readingId);
      need(["A3", "frame"].includes(raw.route), "INVALID_ROUTE");
      if (raw.route === "A3") {
        need(raw.duration === r.duration, "DURATION_MISMATCH");
        budget.spend("asr", raw.duration);
      }
      const segs = segments(raw.segments, r.duration, raw.route);
      need(segs.length > 0, "EMPTY_LOCAL_SOURCE");
      const tokenBudget = this.sourceTokenBudget({ segments: segs });
      return {
        ...this.store.saveReading({
          ...r,
          route: raw.route,
          segments: segs,
          coverage: {
            ...coverage(segs, r.duration, raw.route),
            state:
              raw.route === "frame" ? "visual_text_partial" : "asr_partial",
          },
          localEvidence:
            "User/host supplied import; content not independently verified.",
          cached: false,
        }),
        tokenBudget,
      };
    });
  }
  async audio(readingId, signal) {
    const reading = this.store.reading(readingId);
    return this.task(async (network, budget) => {
      need(reading.duration <= this.limits.asrSeconds, "ASR_BUDGET");
      const bytes = await this.audioBytes(reading, network, budget);
      const dir = join(this.store.root, "assets");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, randomUUID() + ".m4s");
      atomic(path, bytes);
      return {
        path,
        duration: reading.duration,
        bytes: bytes.length,
        note: "Local study asset; not a transcript or a public deliverable.",
      };
    }, signal);
  }
  async audioBytes(reading, network, budget) {
    const u = new URL("https://api.bilibili.com/x/player/playurl");
    u.search = new URLSearchParams({
      bvid: reading.bvid,
      cid: reading.cid,
      qn: 16,
      fnval: 16,
    });
    const response = await network.get(u.href);
    const selected = audioTrack(response.data);
    need(selected, "AUDIO_UNAVAILABLE");
    return firstMediaBytes(network, budget, [
      selected.url,
      ...selected.alternatives,
    ]);
  }
  async runPython(argv, budget, capture = false) {
    return new Promise((resolve, reject) => {
      budget.check();
      const child = this.spawn(pythonFor(this.config, this.store.root), argv, {
        stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
        windowsHide: true,
      });
      let fault = null,
        stdout = Buffer.alloc(0);
      if (capture)
        child.stdout.on("data", (chunk) => {
          if (stdout.length + chunk.length > 16384) {
            fault = new Fault("FRAME_DOCTOR_OUTPUT_LIMIT");
            child.kill();
          } else stdout = Buffer.concat([stdout, chunk]);
        });
      const stop = () => {
        fault = new Fault("CANCELLED");
        child.kill();
      };
      const tick = setInterval(() => {
        try {
          budget.check();
        } catch (error) {
          fault = error;
          child.kill();
        }
      }, 100);
      budget.signal?.addEventListener("abort", stop, { once: true });
      child.once("error", () => {
        fault ||= new Fault("LOCAL_MEDIA_DEPENDENCY_FAILED");
      });
      child.once("close", (code) => {
        clearInterval(tick);
        budget.signal?.removeEventListener("abort", stop);
        try {
          budget.check();
          if (fault) throw fault;
          need(code === 0, "LOCAL_MEDIA_FAILED");
          resolve(stdout.toString("utf8"));
        } catch (error) {
          reject(error);
        }
      });
      if (budget.signal?.aborted) stop();
    });
  }
  async frameDoctor(budget) {
    try {
      const output = await this.runPython(
        [
          fileURLToPath(
            new URL("../scripts/frame_environment.py", import.meta.url),
          ),
          "doctor",
        ],
        budget,
        true,
      );
      need(
        JSON.parse(output).status === "ready",
        "FRAME_DEPENDENCIES_UNAVAILABLE",
      );
    } catch (error) {
      if (
        [
          "CANCELLED",
          "WALL_BUDGET",
          "PERSISTENT_PAUSE",
          "DAILY_WINDOW_CLOSED",
        ].includes(error.code)
      )
        throw error;
      throw new Fault(
        "FRAME_DEPENDENCIES_UNAVAILABLE",
        "Frame dependencies unavailable. Run bili-humanism setup-media, then bili-humanism doctor with the same dataDir; see docs/LOCAL_FRAMES.md. A text-only host model still cannot receive images.",
      );
    }
  }
  async runMedia(
    mode,
    reading,
    input,
    output,
    budget,
    model = "",
    visual = false,
    { at = null, title = "", vad = false } = {},
  ) {
    need(
      Number.isFinite(reading.duration) &&
        reading.duration > 0 &&
        reading.duration <= Number.MAX_SAFE_INTEGER,
      "INVALID_MEDIA_DURATION",
    );
    const argv = [
      fileURLToPath(new URL("../scripts/media.py", import.meta.url)),
      mode,
      input,
      output,
      "--duration",
      String(reading.duration),
    ];
    const remaining = budget.remaining();
    if (Number.isFinite(remaining))
      argv.push(
        "--max-wall-seconds",
        String(
          Math.max(
            1,
            remaining / 1000 - (visual ? VISUAL_WALL_MARGIN_SECONDS : 0),
          ),
        ),
      );
    if (
      this.config.maxMediaSeconds !== undefined ||
      this.config.limits?.asrSeconds !== undefined
    )
      argv.push("--max-seconds", String(this.limits.asrSeconds));
    if (mode === "asr") {
      argv.push("--model", model);
      if (title)
        argv.push(
          "--initial-prompt",
          `以下是 B 站视频《${title}》的原始音轨。`,
          "--hotwords",
          title,
        );
      if (vad) argv.push("--vad");
    } else
      argv.push(
        ...(at
          ? ["--at", at.join(",")]
          : ["--interval", String(Math.max(15, reading.duration / 39))]),
        "--strict-duration",
      );
    if (visual)
      argv.push(
        "--max-short-side",
        "480",
        "--max-long-side",
        "1920",
        "--max-pixels",
        "921600",
      );
    await this.runPython(argv, budget);
  }
  async visual(readingId, signal) {
    const reading = this.store.reading(readingId);
    return this.task(
      (network, budget) => this.prepareVisual(reading, network, budget),
      signal,
    );
  }
  /** Frames at moments the caller chose, kept apart from the sampled "visual:" index. */
  async visualAt(readingId, at, signal) {
    const reading = this.store.reading(readingId);
    const times = chosenTimes(at, reading.duration);
    const key = "visual-at:" + readingId;
    // The same moments again need no second download of the whole video.
    const wanted = distinctTimes(times);
    const known = this.store.getControl(key)?.times;
    if (
      Array.isArray(known) &&
      known.length === wanted.length &&
      known.every((time, index) => time === wanted[index])
    ) {
      try {
        return { result: this.framePage(key, readingId), usage: { requests: 0 } };
      } catch {
        /* The frames were removed by hand: fetch them again. */
      }
    }
    return this.task(
      (network, budget) => this.prepareVisual(reading, network, budget, times),
      signal,
    );
  }
  async prepareVisual(reading, network, budget, at = null, settle = true) {
    const readingId = reading.id;
    need(reading.duration <= this.limits.asrSeconds, "MEDIA_DURATION_BUDGET");
    budget.check();
    await this.frameDoctor(budget);
    budget.check();
    const owned = temporaryVideo(this.store.root);
    let failed, index;
    try {
      const u = new URL("https://api.bilibili.com/x/player/playurl");
      u.search = new URLSearchParams({
        bvid: reading.bvid,
        cid: reading.cid,
        qn: 32,
        fnval: 16,
        fourk: 0,
      });
      const response = await network.get(u.href);
      const selected = videoTrack(response.data, reading.duration);
      if (selected.transport === "durl")
        need(
          response.data.durl[0].length <= (reading.duration + 1) * 1000,
          "MEDIA_DURATION_BUDGET",
        );
      const bytes = await firstMediaBytes(network, budget, [
        selected.url,
        ...selected.alternatives,
      ]);
      owned.write(bytes);
      budget.check();
      const assets = join(realpathSync(this.store.root), "assets");
      mkdirSync(assets, { recursive: true, mode: 0o700 });
      noLinks(assets);
      const output = join(assets, "visual-" + randomUUID());
      await this.runMedia(
        "frames",
        reading,
        owned.path,
        output,
        budget,
        "",
        true,
        { at },
      );
      const manifest = JSON.parse(
        readFileSync(join(output, "manifest.json"), "utf8"),
      );
      noLinks(output);
      need(realpathSync(output) === output, "VISUAL_PATH_DENIED");
      need(
        manifest.route === "frame" &&
          manifest.duration === reading.duration &&
          Array.isArray(manifest.frames) &&
          manifest.frames.length > 0 &&
          manifest.frames.length <= (at ? at.length : 40) &&
          (!at || manifest.sampling === "chosen"),
        "INVALID_VISUAL_MANIFEST",
      );
      for (const frame of manifest.frames) {
        need(
          Number.isFinite(frame.at) &&
            frame.at >= 0 &&
            frame.at <= reading.duration + 1 &&
            /^frame-\d{3}-\d+\.\d{2}\.jpg$/.test(frame.file) &&
            Number.isInteger(frame.width) &&
            frame.width > 0 &&
            frame.width <= 1920 &&
            Number.isInteger(frame.height) &&
            frame.height > 0 &&
            frame.height <= 1920 &&
            Math.min(frame.width, frame.height) <= 480 &&
            frame.width * frame.height <= 480 * 1920,
          "INVALID_VISUAL_MANIFEST",
        );
        const image = boundedFrameBytes(join(output, frame.file));
        need(
          image.length > 0 && image.length <= 2 * 1024 * 1024,
          "VISUAL_IMAGE_BYTES",
        );
        frame.bytes = image.length;
        frame.sha256 = createHash("sha256").update(image).digest("hex");
      }
      const directoryStatus = lstatSync(output, { bigint: true });
      index = {
        directory: output,
        manifest,
        directoryIdentity: {
          dev: String(directoryStatus.dev),
          ino: String(directoryStatus.ino),
        },
        transport: selected.transport,
        quality: selected.quality,
      };
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      await cleanupVideo(owned, failed);
    }
    const key = (at ? "visual-at:" : "visual:") + readingId;
    this.store.setControl(
      key,
      at ? { ...index, times: distinctTimes(at) } : index,
    );
    return this.framePage(key, readingId, 0, settle);
  }
  visualFrames(readingId, offset = 0) {
    return this.framePage("visual:" + readingId, readingId, offset);
  }
  /**
   * The frame page a read shows, once its text and danmaku are in. A new transcript
   * has its own reading ID, and an index without a usable order has not chosen one
   * yet: only now can danmaku peaks steer the first page.
   */
  readFrames(page, readingId) {
    const entry = this.store.getControl("visual:" + readingId);
    return entry &&
      (page.readingId !== readingId ||
        !validOrder(entry.order, entry.manifest?.frames?.length))
      ? this.visualFrames(readingId)
      : page;
  }
  // Strongest first. peaks() answers in time order.
  danmakuPeakTimes(readingId, duration) {
    const entry = this.store.getControl("danmaku:" + readingId);
    return entry
      ? peaks(danmakuItems(entry), duration)
          .sort((a, b) => b.n - a.n || a.at - b.at)
          .map(({ at }) => at)
      : [];
  }
  framePage(key, readingId, offset = 0, settle = true) {
    const reading = this.store.reading(readingId);
    need(
      Number.isSafeInteger(offset) && offset >= 0 && offset <= 40,
      "INVALID_VISUAL_OFFSET",
    );
    const entry = this.store.getControl(key);
    need(
      entry &&
        typeof entry.directory === "string" &&
        Array.isArray(entry.manifest?.frames) &&
        entry.manifest.frames.length <= 40,
      "VISUAL_NOT_PREPARED",
    );
    const root = realpathSync(this.store.root),
      assets = join(root, "assets");
    need(
      inside(assets, entry.directory) &&
        /^visual-[0-9a-f-]{36}$/.test(entry.directory.slice(assets.length + 1)),
      "VISUAL_PATH_DENIED",
    );
    noLinks(entry.directory);
    need(
      realpathSync(entry.directory) === entry.directory,
      "VISUAL_PATH_DENIED",
    );
    const directoryStatus = lstatSync(entry.directory, { bigint: true });
    need(
      directoryStatus.isDirectory() &&
        entry.directoryIdentity?.dev === String(directoryStatus.dev) &&
        entry.directoryIdentity?.ino === String(directoryStatus.ino),
      "VISUAL_PATH_DENIED",
    );
    // Entries from older versions have no order yet. Once chosen it stays, so danmaku
    // arriving between pages cannot repeat or skip a frame. A read holds its page back
    // until its danmaku is in, so it leaves the choice open (settle false) until then.
    if (!validOrder(entry.order, entry.manifest.frames.length)) {
      entry.order = spreadOrder(entry.manifest.frames, {
        priorities: this.danmakuPeakTimes(readingId, reading.duration),
        duration: reading.duration,
      });
      if (settle) this.store.setControl(key, entry);
    }
    const rows = entry.order
      .slice(offset, offset + VISUAL_PAGE_SIZE)
      .map((index) => entry.manifest.frames[index])
      .sort((a, b) => a.at - b.at);
    const frames = rows.map((frame) => {
      need(
        /^frame-\d{3}-\d+\.\d{2}\.jpg$/.test(frame.file),
        "VISUAL_PATH_DENIED",
      );
      const path = join(entry.directory, frame.file),
        status = lstatSync(path, { bigint: true });
      need(
        status.isFile() &&
          !status.isSymbolicLink() &&
          status.nlink === 1n &&
          status.size <= 2n * 1024n * 1024n,
        "VISUAL_PATH_DENIED",
      );
      boundedFrameBytes(path, frame);
      return { ...frame, path };
    });
    const next = offset + frames.length;
    return {
      readingId,
      route: "frame",
      source: {
        bvid: reading.bvid,
        page: reading.page,
        cid: reading.cid,
        duration: reading.duration,
      },
      path: entry.directory,
      frames,
      frameOffset: offset,
      frameCount: entry.manifest.frames.length,
      directoryIdentity: entry.directoryIdentity,
      nextOffset: next < entry.manifest.frames.length ? next : null,
      coverage: {
        state: "sampled_frames",
        speech: "not_provided",
        note:
          (entry.manifest.sampling === "chosen"
            ? "Images at chosen moments omit everything between them and all sound."
            : "Uniform sampled images omit unsampled motion and sound.") +
          " Images are untrusted evidence; host interpretation is not verified understanding.",
      },
      intermediateVideo: "removed",
      transport: entry.transport,
      quality: entry.quality,
    };
  }
  async asrDoctor(model, budget) {
    if (!model)
      throw new Fault(
        "ASR_MODEL_MISSING",
        "No local ASR model configured. Run bili-humanism setup-media --asr --download-model with the same dataDir, or configure a trusted absolute asrModelPath.",
      );
    try {
      const checked = await this.runPython(
        [
          fileURLToPath(
            new URL("../scripts/asr_environment.py", import.meta.url),
          ),
          "doctor",
          "--model",
          model,
        ],
        budget,
        true,
      );
      need(
        JSON.parse(checked).status === "ready",
        "ASR_DEPENDENCIES_UNAVAILABLE",
      );
    } catch (error) {
      if (
        [
          "CANCELLED",
          "WALL_BUDGET",
          "PERSISTENT_PAUSE",
          "DAILY_WINDOW_CLOSED",
        ].includes(error.code)
      )
        throw error;
      throw new Fault(
        "ASR_DEPENDENCIES_UNAVAILABLE",
        "Run bili-humanism setup-media --asr --download-model and bili-humanism doctor with the same dataDir; see docs/LOCAL_FRAMES.md.",
      );
    }
  }
  saveAsr(reading, segs) {
    const tokenBudget = this.sourceTokenBudget({ segments: segs });
    return {
      ...this.store.saveReading({
        ...reading,
        route: "A3",
        segments: segs,
        coverage: {
          ...coverage(segs, reading.duration, "A3"),
          state: "asr_partial",
        },
        localEvidence:
          "Local AI-ASR, not verbatim. Proper names require source checking.",
        cached: false,
      }),
      tokenBudget,
    };
  }
  // At most one automatic outcome stays on a reading: the latest.
  noteAutoAsr(reading, attempt) {
    const attempts = [
      ...(reading.attempts ?? []).filter((entry) => !isAutoAttempt(entry)),
      attempt,
    ];
    this.store.setReadingAttempts(reading.id, attempts);
    return { ...reading, attempts };
  }
  /**
   * What a read shows after auto ASR. A stored row keeps the attempts of the read that
   * created it, so this read's own stay and only the automatic outcome comes over.
   */
  heardView(source, heard) {
    const fresh = source.attempts ?? [];
    const automatic = (heard.attempts ?? []).filter(isAutoAttempt);
    if (heard.id === source.id)
      return {
        ...source,
        attempts: [
          ...fresh.filter((entry) => !isAutoAttempt(entry)),
          ...automatic,
        ],
      };
    if (heard.reusedLocalSource)
      return {
        ...heard,
        cached: source.cached,
        deduplicated: true,
        networkSource: networkSource(source),
      };
    return {
      ...heard,
      attempts: [...fresh.filter(({ route }) => route !== "A3"), ...automatic],
    };
  }
  // Whether a remembered outcome still answers for this reading and this config. Anything
  // else runs again, as a saved outcome does: its transcript no longer matches the source.
  autoAsrSettled(known, reading) {
    if (known.state === "auto_not_better")
      return textCharacters(reading.segments) >= known.heardCharacters;
    if (known.malformed) return true;
    if (known.error === "WALL_BUDGET")
      return this.config.autoAsrWallMs <= known.wallMs;
    if (known.error === "LOCAL_MEDIA_FAILED")
      return known.runs >= AUTO_ASR_FAILED_RUNS;
    if (known.error === "READ_TOKEN_BUDGET")
      return this.config.maxReadTokens <= known.maxReadTokens;
    return false;
  }
  // What a failed run leaves behind. Only what says something about the video stays;
  // a bigger budget may still change a limit it ran into.
  autoAsrFailureMemory(attempt, stage, known) {
    if (stage === "output") return { ...attempt, malformed: true };
    if (stage === "heard" && attempt.error === "READ_TOKEN_BUDGET")
      return { ...attempt, maxReadTokens: this.config.maxReadTokens };
    if (stage !== "running") return null;
    if (attempt.error === "WALL_BUDGET")
      return { ...attempt, wallMs: this.config.autoAsrWallMs };
    if (attempt.error === "LOCAL_MEDIA_FAILED")
      return {
        ...attempt,
        runs: (known?.error === attempt.error ? (known.runs ?? 1) : 0) + 1,
      };
    return null;
  }
  // A transcript gets a new reading ID; frames and reactions of the same video stay
  // reachable from it, without fetching them again.
  carryControls(fromId, toId) {
    for (const prefix of ["visual:", "visual-at:", "danmaku:"]) {
      const value = this.store.getControl(prefix + fromId);
      if (value && !this.store.getControl(prefix + toId))
        this.store.setControl(prefix + toId, value);
    }
  }
  /**
   * Local speech text for a reading that has little or none. Only the DSH read tool
   * calls this: daily fetching and the plain CLI read never do. Returns the reading to
   * show, which is a different one when a longer transcript exists. Whatever goes wrong
   * becomes an attempts entry, except cancellation and a persistent pause. An outcome
   * that says something about the video is remembered per bvid+cid and not repeated: a
   * transcript that was produced or malformed output. A time or token limit it ran into
   * stands until that limit is raised, and a crash gets a few runs. A missing environment,
   * a failed download or a too-long source is not remembered: nothing was tried and a
   * human may still fix them.
   */
  async autoAsr(readingId, signal) {
    const reading = this.store.reading(readingId);
    if (!this.config.autoAsr || !missingSpeech(reading)) return reading;
    const key = `auto-asr:${reading.bvid}:${reading.cid}`;
    let stage = "before",
      known = null;
    try {
      if (signal?.aborted) throw new Fault("CANCELLED");
      const transcript = this.store.localTranscript(reading);
      if (transcript) {
        if (
          textCharacters(transcript.segments) <=
          textCharacters(reading.segments)
        )
          return this.noteAutoAsr(reading, {
            route: "A3",
            state: "auto_not_better",
          });
        const tokenBudget = this.sourceTokenBudget(transcript);
        this.carryControls(reading.id, transcript.id);
        return {
          ...transcript,
          reusedLocalSource: true,
          networkSource: networkSource(reading),
          tokenBudget,
        };
      }
      known = this.store.getControl(key);
      if (known && this.autoAsrSettled(known, reading))
        return this.noteAutoAsr(reading, autoAttempt(known));
      if (
        reading.duration >
        Math.min(this.config.autoAsrMaxSeconds, this.limits.asrSeconds)
      )
        return this.noteAutoAsr(reading, {
          route: "A3",
          state: "auto_skipped_duration",
        });
      const limits = { ...this.limits, wallMs: this.config.autoAsrWallMs };
      const { result } = await this.task(
        async (network, budget) => {
          const model = modelFor(this.config, this.store.root);
          await this.asrDoctor(model, budget);
          budget.spend("asr", reading.duration);
          const owned = temporaryVideo(this.store.root, "audio.m4s");
          const output = owned.path + ".json";
          let failed, heard;
          try {
            owned.write(await this.audioBytes(reading, network, budget));
            budget.check();
            stage = "running";
            await this.runMedia(
              "asr",
              reading,
              owned.path,
              output,
              budget,
              model,
              false,
              { title: asrTitle(reading.title), vad: true },
            );
            stage = "output";
            let written;
            try {
              written = JSON.parse(readFileSync(output, "utf8"));
            } catch {
              throw new Fault("ASR_OUTPUT_INVALID");
            }
            heard = segments(written?.segments, reading.duration, "A3");
            stage = "heard";
          } catch (error) {
            failed = error;
            throw error;
          } finally {
            try {
              rmSync(output, { force: true });
            } catch {
              /* The task directory below then refuses removal and reports it. */
            }
            await cleanupVideo(owned, failed);
          }
          const heardCharacters = textCharacters(heard);
          if (heardCharacters <= textCharacters(reading.segments)) {
            const attempt = { route: "A3", state: "auto_not_better" };
            // Measured against this reading: one with less text may run again.
            this.store.setControl(key, { ...attempt, heardCharacters });
            return this.noteAutoAsr(reading, attempt);
          }
          const saved = this.saveAsr(
            {
              ...reading,
              attempts: [
                ...(reading.attempts ?? []).filter(
                  ({ route }) => route !== "A3",
                ),
                { route: "A3", state: "auto_saved" },
              ],
            },
            heard,
          );
          this.store.setControl(key, {
            route: "A3",
            state: "auto_saved",
            readingId: saved.id,
          });
          this.carryControls(reading.id, saved.id);
          return saved;
        },
        signal,
        limits,
      );
      return result;
    } catch (error) {
      // CREDENTIAL_INVALID and CREDENTIAL_EXPIRED have just set the persistent pause.
      if (
        [
          "CANCELLED",
          "PERSISTENT_PAUSE",
          "PLATFORM_PAUSED",
          "CREDENTIAL_INVALID",
          "CREDENTIAL_EXPIRED",
        ].includes(error.code)
      )
        throw error;
      const attempt = autoAsrFailure(error);
      const memory = this.autoAsrFailureMemory(attempt, stage, known);
      if (memory) this.store.setControl(key, memory);
      return this.noteAutoAsr(reading, attempt);
    }
  }
  async localMedia(mode, readingId, input, model = "", signal) {
    const reading = this.store.reading(readingId);
    need(["asr", "frames"].includes(mode), "INVALID_ROUTE");
    return this.task(async (_network, budget) => {
      if (mode === "asr") {
        budget.spend("asr", reading.duration);
        model ||= modelFor(this.config, this.store.root);
        await this.asrDoctor(model, budget);
      } else
        need(
          reading.duration <= this.limits.asrSeconds,
          "MEDIA_DURATION_BUDGET",
        );
      const dir = join(this.store.root, "assets");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const output = join(dir, randomUUID() + (mode === "asr" ? ".json" : ""));
      await this.runMedia(mode, reading, input, output, budget, model);
      if (mode === "frames")
        return {
          path: output,
          status: "sampled_frames",
          note: "No automatic OCR. Host vision interpretation must retain timestamps and partial-coverage warning.",
        };
      const raw = JSON.parse(readFileSync(output, "utf8"));
      const segs = segments(raw.segments, reading.duration, "A3");
      need(segs.length, "EMPTY_LOCAL_SOURCE");
      return this.saveAsr(reading, segs);
    }, signal);
  }
  memory(action, id = "", body = null) {
    need(["list", "put", "delete"].includes(action), "INVALID_MEMORY_ACTION");
    if (action === "put") {
      need(
        body && ["self", "user"].includes(body.subject),
        "THIRD_PARTY_PROFILE_DENIED",
      );
      need(
        Object.keys(body).every((k) =>
          [
            "subject",
            "understanding",
            "evidence",
            "uncertainty",
            "next_response",
          ].includes(k),
        ),
        "INVALID_MEMORY_FIELD",
      );
      for (const key of [
        "understanding",
        "evidence",
        "uncertainty",
        "next_response",
      ])
        text(body[key] || "");
      need(body.understanding && body.evidence, "MEMORY_EVIDENCE_REQUIRED");
    }
    return this.store.memory(action, id, body);
  }
  close() {
    this.questions.closed = true;
    this.shadow.closed = true;
    if (this.closing) return;
    this.closing = true;
    this.dailyFetcher.stop();
    for (const controller of this.active) controller.abort();
    if (this.active.size === 0) this.store.close();
  }
}
export function readingView(reading, offset = 0) {
  need(
    Number.isInteger(offset) &&
      offset >= 0 &&
      offset <= reading.segments.length,
    "INVALID_OFFSET",
  );
  const chosen = [];
  let length = 0;
  for (const segment of reading.segments.slice(offset)) {
    if (length + segment.text.length > 16000 && chosen.length) break;
    chosen.push(segment);
    length += segment.text.length;
    if (length >= 16000) break;
  }
  return {
    ...reading,
    segments: chosen,
    segment_count: reading.segments.length,
    next_offset:
      offset + chosen.length < reading.segments.length
        ? offset + chosen.length
        : null,
    source_text_partial: offset > 0 || chosen.length < reading.segments.length,
  };
}
export { safeError };
