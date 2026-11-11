import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../index.js";
import { Service } from "../lib/service.mjs";
import { Fault } from "../lib/errors.mjs";
import jpeg from "./visual-fixture.mjs";

function harness(t, mode, route = "A1", criticalCode, options = {}) {
  const duration = options.duration ?? 742;
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "humanism-read-image-failure-")),
  );
  const dir = join(root, "assets", "synthetic-frames");
  mkdirSync(dir, { recursive: true });
  const file = "frame-000-0.00.jpg";
  writeFileSync(join(dir, file), jpeg);
  const tools = new Map(),
    inputs = [],
    controller = new AbortController();
  const previous = Object.fromEntries(
    ["readVisual", "visual", "visualFrames"].map((k) => [
      k,
      Service.prototype[k],
    ]),
  );
  let service, visual, dispose;
  Service.prototype.readVisual = async function () {
    service = this;
    if (mode === "source-risk") throw new Fault("PLATFORM_PAUSED");
    const saved = this.store.saveReading({
      bvid: "BV0000000001",
      page: 1,
      cid: 7,
      duration,
      route,
      title: "Synthetic long source",
      url: "https://www.bilibili.com/video/BV0000000001/?p=1",
      segments:
        route === "A1"
          ? [
              {
                start: 0,
                end: 10,
                text: "Synthetic preserved text",
                source: "A1",
              },
            ]
          : [],
      coverage: {
        state: route === "A1" ? "partial" : "read_failed",
        speech: "unknown",
      },
    });
    visual = {
      readingId: saved.id,
      path: dir,
      source: { bvid: saved.bvid, page: 1, cid: 7, duration },
      frameOffset: 0,
      frameCount: mode === "page-invalid" ? (options.frameCount ?? 41) : 1,
      nextOffset: null,
      frames: [
        {
          at: 0,
          file,
          path: join(dir, file),
          bytes: jpeg.length,
          sha256:
            mode === "frame-changed"
              ? "f".repeat(64)
              : createHash("sha256").update(jpeg).digest("hex"),
        },
      ],
      coverage: { state: "sampled_frames" },
      intermediateVideo: "removed",
    };
    return {
      taskId: "synthetic-task",
      usage: { requests: 4 },
      result: { ...saved, visual },
    };
  };
  Service.prototype.visual = async () => ({ result: visual });
  Service.prototype.visualFrames = () => visual;
  const attachments = {
    imageLimits: {
      maxImageBytes: 4194304,
      maxMessageImageBytes: 8388608,
      maxImagesPerMessage: 4,
      maxImageDimension: 1920,
      maxImagePixels: 921600,
      mediaTypes: ["image/jpeg"],
    },
    async saveImages(batch) {
      inputs.push(...batch);
      if (mode === "host-error")
        throw Error("PRIVATE_HOST_PATH_OR_TOKEN_MUST_NOT_ESCAPE");
      if (mode === "critical") throw new Fault(criticalCode);
      if (mode === "abort") {
        controller.abort();
        throw new Fault("VISUAL_ATTACHMENT_INVALID");
      }
      if (mode === "attachment-invalid") return [];
      return batch.map((x) => ({
        attachmentId:
          "sha256:" + createHash("sha256").update(x.data).digest("hex"),
        mediaType: "image/jpeg",
        bytes: x.data.length,
        width: 160,
        height: 96,
      }));
    },
  };
  apply(
    {
      tools: { register: (tool) => tools.set(tool.name, tool) },
      effect: (setup) => {
        dispose = setup();
      },
      get: (name) =>
        name === "attachments"
          ? attachments
          : name === "llm"
            ? {
                resolveModelInfo: async () => ({
                  inputModalities: ["text", "image"],
                }),
              }
            : undefined,
    },
    { dataDir: root, enableDailyFetching: false },
  );
  t.after(() => {
    dispose?.();
    for (const [k, v] of Object.entries(previous)) Service.prototype[k] = v;
  });
  const exec = {
    signal: controller.signal,
    agent: {
      session: {
        requestHeader: () => ({
          config: { provider: "synthetic", model: "vision" },
        }),
      },
    },
  };
  const call = async (name, args) => {
    const value = await tools.get("bili_humanism_" + name).execute(args, exec);
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const blocks = tools
      .get("bili_humanism_" + name)
      .output.render(args, value);
    return { parsed, value, blocks };
  };
  return {
    root,
    inputs,
    call,
    get service() {
      return service;
    },
  };
}

for (const route of ["A1", "none"])
  test(`optional invalid frame page preserves the saved ${route} reading and permits local import`, async (t) => {
    const f = harness(t, "page-invalid", route);
    const {
      parsed: r,
      value,
      blocks,
    } = await f.call("read", { video: "BV0000000001" });
    assert.ok(
      r.result?.id,
      "A saved reading ID must survive optional image delivery failure",
    );
    assert.equal(r.result.route, route);
    assert.equal(r.result.segments.length, route === "A1" ? 1 : 0);
    assert.equal(r.visual.status, "unavailable");
    assert.equal(r.visual.error, "VISUAL_PAGE_INVALID");
    assert.equal(r.result.visual, undefined);
    assert.equal(r.usage.requests, 4);
    assert.equal(blocks.filter((x) => x.type === "image").length, 0);
    assert.ok(!value.includes(JSON.stringify(f.root).slice(1, -1)));
    assert.equal(f.inputs.length, 0);
    assert.equal(f.service.store.reading(r.result.id).route, route);
    const imported = await f.call("import", {
      readingId: r.result.id,
      json: JSON.stringify({
        route: "A3",
        duration: 742,
        segments: [{ start: 0, end: 5, text: "Synthetic human local import" }],
      }),
    });
    assert.equal(imported.parsed.result.route, "A3");
    for (const name of ["visual", "frames"]) {
      const direct = await f.call(name, { readingId: r.result.id });
      assert.equal(direct.parsed.error, "VISUAL_PAGE_INVALID");
      assert.equal(direct.blocks.filter((x) => x.type === "image").length, 0);
    }
  });

for (const route of ["A1", "none"])
  test(`an oversized optional frame page keeps the ${route} source usable through frame import and journal`, async (t) => {
    const f = harness(t, "page-invalid", route, undefined, {
      duration: 930,
      frameCount: 57,
    });
    const { parsed: reading, blocks } = await f.call("read", {
      video: "BV0000000001",
    });
    assert.ok(reading.result?.id);
    assert.equal(reading.result.route, route);
    assert.equal(reading.visual.status, "unavailable");
    assert.equal(reading.visual.error, "VISUAL_PAGE_INVALID");
    assert.equal(blocks.filter((x) => x.type === "image").length, 0);
    const { parsed: imported } = await f.call("import", {
      readingId: reading.result.id,
      json: JSON.stringify({
        route: "frame",
        segments: [
          { start: 3, end: 6, text: "Synthetic host-supplied visual text" },
        ],
      }),
    });
    assert.ok(imported.result?.id);
    assert.equal(imported.result.route, "frame");
    assert.equal(imported.result.coverage.state, "visual_text_partial");
    const args = {
      readingId: imported.result.id,
      json: JSON.stringify({
        encounter: "Synthetic reflection after a local text import",
        missing:
          "Only host-supplied text; no validated video images were delivered",
        evidence: [{ at: 3, claim: "Synthetic host-supplied visual text" }],
      }),
    };
    const { parsed: journal } = await f.call("journal", args);
    assert.ok(journal.id);
    assert.equal(journal.readingId, imported.result.id);
    assert.equal(journal.status, "local_reviewable_draft");
    assert.equal((await f.call("journal", args)).parsed.id, journal.id);
    assert.equal(
      f.service.store.db.prepare("SELECT count(*) n FROM notes").get().n,
      1,
    );
    assert.equal(f.service.store.reading(reading.result.id).route, route);
    assert.equal(f.inputs.length, 0);
  });

for (const [mode, error] of [
  ["frame-changed", "VISUAL_FRAME_CHANGED"],
  ["attachment-invalid", "VISUAL_ATTACHMENT_INVALID"],
  ["host-error", "INTERNAL_ERROR"],
])
  test(`optional ${mode} rejects all images but preserves text and the reading ID`, async (t) => {
    const f = harness(t, mode);
    const {
      parsed: r,
      value,
      blocks,
    } = await f.call("read", { video: "BV0000000001" });
    assert.ok(r.result?.id);
    assert.equal(r.result.segments[0].text, "Synthetic preserved text");
    assert.equal(r.visual.status, "unavailable");
    assert.equal(r.visual.error, error);
    assert.equal(blocks.filter((x) => x.type === "image").length, 0);
    assert.ok(!value.includes("PRIVATE_HOST_PATH_OR_TOKEN_MUST_NOT_ESCAPE"));
  });

for (const code of [
  "CANCELLED",
  "PLATFORM_PAUSED",
  "PERSISTENT_PAUSE",
  "CREDENTIAL_EXPIRED",
  "REQUESTS_BUDGET",
  "WALL_BUDGET",
  "READ_TOKEN_BUDGET",
  "URL_DENIED",
])
  test(`optional delivery never turns ${code} into a successful reading`, async (t) => {
    const f = harness(t, "critical", "A1", code);
    const { parsed: r, blocks } = await f.call("read", {
      video: "BV0000000001",
    });
    assert.equal(r.error, code);
    assert.equal(r.result, undefined);
    assert.equal(blocks.filter((x) => x.type === "image").length, 0);
  });

test("an aborted attachment step does not return fallback success", async (t) => {
  const f = harness(t, "abort");
  const { parsed: r, blocks } = await f.call("read", { video: "BV0000000001" });
  assert.ok(r.error);
  assert.equal(r.result, undefined);
  assert.equal(blocks.filter((x) => x.type === "image").length, 0);
});

test("source-stage platform risk remains fatal before optional attachment handling", async (t) => {
  const f = harness(t, "source-risk");
  const { parsed: r } = await f.call("read", { video: "BV0000000001" });
  assert.equal(r.error, "PLATFORM_PAUSED");
  assert.equal(r.result, undefined);
  assert.equal(f.inputs.length, 0);
});
