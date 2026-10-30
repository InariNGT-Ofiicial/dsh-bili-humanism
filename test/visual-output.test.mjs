import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  linkSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import * as plugin from "../index.js";
import { Service } from "../lib/service.mjs";
import {
  attachVisualPage,
  visualCapability,
  renderVisualOutput,
  renderReadOutput,
  VISUAL_OUTPUT_SCHEMA,
} from "../lib/visual-output.mjs";
import jpeg, { portrait } from "./visual-fixture.mjs";

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "humanism-visual-output-")),
  );
  const path = join(root, "assets", "synthetic-frames");
  mkdirSync(path, { recursive: true });
  const file = "frame-000-0.00.jpg";
  writeFileSync(join(path, file), jpeg);
  const visual = {
    readingId: "synthetic-reading",
    path,
    source: { bvid: "BV0000000001", page: 1, cid: 7, duration: 60 },
    frameOffset: 0,
    frameCount: 1,
    nextOffset: null,
    frames: [
      {
        at: 0,
        file,
        path: join(path, file),
        bytes: jpeg.length,
        sha256: createHash("sha256").update(jpeg).digest("hex"),
      },
    ],
    coverage: { state: "sampled_frames" },
    intermediateVideo: "removed",
  };
  const saved = [];
  const attachments = {
    imageLimits: {
      maxImageBytes: 4 * 1024 * 1024,
      maxMessageImageBytes: 8 * 1024 * 1024,
      maxImagesPerMessage: 4,
      maxImageDimension: 1920,
      maxImagePixels: 921600,
      mediaTypes: ["image/jpeg"],
    },
    async saveImages(inputs) {
      saved.push(...inputs);
      return inputs.map((input) => ({
        attachmentId:
          "sha256:" + createHash("sha256").update(input.data).digest("hex"),
        mediaType: "image/jpeg",
        bytes: input.data.length,
        width: 160,
        height: 96,
        name: input.name,
      }));
    },
  };
  const exec = {
    agent: {
      session: {
        requestHeader: () => ({
          config: { provider: "synthetic", model: "vision" },
        }),
      },
    },
  };
  const ctx = {
    get(name) {
      return name === "attachments"
        ? attachments
        : name === "llm"
          ? {
              async resolveModelInfo(provider, model) {
                assert.equal(provider, "synthetic");
                assert.equal(model, "vision");
                return { inputModalities: ["text", "image"] };
              },
            }
          : undefined;
    },
  };
  return { root, path, visual, saved, attachments, ctx, exec };
}

for (const duration of [600, 601, 915, 2297]) {
  test(`visual attachment accepts a bounded page from a ${duration}-second source`, async () => {
    const f = fixture();
    f.visual.source.duration = duration;
    const result = await attachVisualPage(f.attachments, f.root, f.visual);
    assert.equal(result.status, "frames_ready");
    assert.equal(result.images.length, 1);
    assert.equal(f.saved.length, 1);
    assert.ok(!JSON.stringify(result).includes(f.root));
  });
}

test("visual source duration remains finite, positive and safely representable", async () => {
  for (const duration of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    f.visual.source.duration = duration;
    await assert.rejects(attachVisualPage(f.attachments, f.root, f.visual), {
      code: "VISUAL_PAGE_INVALID",
    });
    assert.equal(f.saved.length, 0);
  }
});

test("long visual sources retain total-frame and offset invariants", async () => {
  for (const change of [
    { frameCount: 41 },
    { frameOffset: 1 },
    { nextOffset: 1 },
  ]) {
    const f = fixture();
    f.visual.source.duration = 915;
    Object.assign(f.visual, change);
    await assert.rejects(attachVisualPage(f.attachments, f.root, f.visual), {
      code: "VISUAL_PAGE_INVALID",
    });
    assert.equal(f.saved.length, 0);
  }
});

test("read, visual and frames tools deliver a long source without dropping its text", async () => {
  const f = fixture();
  f.visual.source.duration = 915;
  const tools = new Map();
  let dispose;
  const previous = Object.fromEntries(
    ["readVisual", "visual", "visualFrames"].map((name) => [
      name,
      Service.prototype[name],
    ]),
  );
  const page = (offset) => ({
    ...f.visual,
    frameOffset: offset,
    frameCount: 2,
    nextOffset: offset === 0 ? 1 : null,
  });
  Service.prototype.readVisual = async () => ({
    taskId: "synthetic-long-source",
    usage: { requests: 4 },
    result: {
      id: "synthetic-reading",
      bvid: "BV0000000001",
      page: 1,
      cid: 7,
      duration: 915,
      route: "A1",
      segments: [{ start: 0, end: 10, text: "Synthetic long-source text" }],
      coverage: { state: "partial" },
      visual: page(0),
    },
  });
  Service.prototype.visual = async () => ({ result: page(0) });
  Service.prototype.visualFrames = (_id, offset) => page(offset);
  try {
    plugin.apply(
      {
        ...f.ctx,
        tools: { register: (tool) => tools.set(tool.name, tool) },
        effect: (setup) => {
          dispose = setup();
        },
      },
      { dataDir: f.root, enableDailyFetching: false },
    );
    for (const [name, args] of [
      ["read", { video: "BV0000000001" }],
      ["visual", { readingId: "synthetic-reading" }],
      ["frames", { readingId: "synthetic-reading", offset: 1 }],
    ]) {
      const tool = tools.get("bili_humanism_" + name);
      const raw = await tool.execute(args, f.exec);
      const value = typeof raw === "string" ? JSON.parse(raw) : raw;
      assert.equal(value.error, undefined);
      const visual = name === "read" ? value.visual : value;
      assert.equal(visual.status, "frames_ready");
      assert.equal(visual.nextOffset, name === "frames" ? null : 1);
      assert.equal(
        tool.output.render({}, raw).filter((b) => b.type === "image").length,
        1,
      );
      if (name === "read")
        assert.equal(
          value.result.segments[0].text,
          "Synthetic long-source text",
        );
    }
  } finally {
    dispose?.();
    for (const [name, fn] of Object.entries(previous))
      Service.prototype[name] = fn;
  }
});

test("pinned DSH output contract produces durable native image blocks instead of paths", async () => {
  const f = fixture();
  assert.equal(await visualCapability(f.ctx, f.exec), f.attachments);
  const tool = defineTool({
    name: "synthetic_visual",
    description: "Synthetic contract fixture",
    parameters: {},
    output: { schema: VISUAL_OUTPUT_SCHEMA, render: renderVisualOutput },
    async execute() {
      return attachVisualPage(f.attachments, f.root, f.visual);
    },
  });
  const value = await tool.execute({}, {});
  const blocks = tool.output.render({}, value);
  assert.equal(value.status, "frames_ready");
  assert.equal(value.images[0].at, 0);
  assert.equal(blocks.filter((x) => x.type === "image").length, 1);
  assert.deepEqual(blocks.at(-1).attachment, value.images[0].image);
  assert.ok(!JSON.stringify(value).includes(f.path));
  assert.deepEqual(f.saved[0].data, jpeg);
  assert.equal(
    renderReadOutput({}, JSON.stringify({ visual: value })).filter(
      (x) => x.type === "image",
    ).length,
    1,
  );
});

test("missing attachment service and text-only or unknown exact routes refuse before reading media", async () => {
  const f = fixture();
  await assert.rejects(
    () => visualCapability({ get: () => undefined }, f.exec),
    { code: "VISUAL_ATTACHMENT_REQUIRED" },
  );
  await assert.rejects(
    () =>
      visualCapability(
        {
          get: (name) =>
            name === "attachments"
              ? f.attachments
              : {
                  resolveModelInfo: async () => ({ inputModalities: ["text"] }),
                },
        },
        f.exec,
      ),
    { code: "VISUAL_IMAGE_MODEL_REQUIRED" },
  );
  await assert.rejects(() => visualCapability(f.ctx, {}), {
    code: "VISUAL_MODEL_ROUTE_UNAVAILABLE",
  });
  assert.equal(f.saved.length, 0);
});

test("frame delivery refuses changed content, arbitrary paths, hard links and excessive pages", async () => {
  for (const mutate of [
    (f) => writeFileSync(f.visual.frames[0].path, Buffer.alloc(jpeg.length)),
    (f) => {
      f.visual.frames[0].path = join(f.root, "private.txt");
    },
    (f) => {
      f.visual.frames = Array(5).fill(f.visual.frames[0]);
      f.visual.frameCount = 5;
    },
    (f) => {
      f.visual.frames[0].sha256 = "a".repeat(64);
    },
    (f) => {
      linkSync(f.visual.frames[0].path, join(f.root, "synthetic-link.jpg"));
    },
    (f) => {
      f.attachments.imageLimits.maxMessageImageBytes = jpeg.length - 1;
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(() =>
      attachVisualPage(f.attachments, f.root, f.visual),
    );
    assert.equal(f.saved.length, 0);
  }
});

test("frame bytes stay private when a parent directory is a symbolic link", async () => {
  const f = fixture();
  const linked = join(f.root, "assets", "linked");
  symlinkSync(
    f.path,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  f.visual.path = linked;
  f.visual.frames[0].path = join(linked, f.visual.frames[0].file);
  await assert.rejects(
    () => attachVisualPage(f.attachments, f.root, f.visual),
    { code: "VISUAL_PATH_DENIED" },
  );
  assert.equal(f.saved.length, 0);
});

test("generated JPEG dimensions and host limits are checked before attachment writes", async () => {
  const f = fixture();
  f.attachments.imageLimits.maxImagePixels = 100;
  await assert.rejects(
    () => attachVisualPage(f.attachments, f.root, f.visual),
    { code: "VISUAL_ATTACHMENT_LIMIT" },
  );
  assert.equal(f.saved.length, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    attachVisualPage(f.attachments, f.root, f.visual, controller.signal),
  );
  assert.equal(f.saved.length, 0);
});

test("registered visual tools expose IDs and offsets, never model-supplied paths or executables", async () => {
  const f = fixture();
  const tools = new Map();
  let dispose;
  plugin.apply(
    {
      ...f.ctx,
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
        },
      },
      effect(setup) {
        dispose = setup();
      },
    },
    { dataDir: f.root, enableDailyFetching: false },
  );
  assert.deepEqual(
    Object.keys(tools.get("bili_humanism_visual").parameters.properties),
    ["readingId"],
  );
  assert.deepEqual(
    Object.keys(tools.get("bili_humanism_frames").parameters.properties),
    ["readingId", "offset"],
  );
  const rejected = await tools
    .get("bili_humanism_visual")
    .execute({ readingId: "synthetic-reading", path: "secret" }, {});
  assert.equal(rejected.error, "UNKNOWN_PARAMETER");
  assert.equal(plugin.Config({}).pythonPath, "");
  dispose();
});

test("portrait frames use the short-edge rule and normalized attachments retain the lower host caps", async () => {
  const f = fixture();
  const frame = f.visual.frames[0];
  writeFileSync(frame.path, portrait);
  frame.bytes = portrait.length;
  frame.sha256 = createHash("sha256").update(portrait).digest("hex");
  const originalSave = f.attachments.saveImages;
  f.attachments.saveImages = async (inputs) =>
    (await originalSave(inputs)).map((image) => ({
      ...image,
      width: 96,
      height: 160,
      mediaType: "image/png",
    }));
  const result = await attachVisualPage(f.attachments, f.root, f.visual);
  assert.equal(result.images[0].image.width, 96);
  assert.equal(result.images[0].image.mediaType, "image/png");
  f.attachments.imageLimits.maxImageBytes = portrait.length + 1;
  f.attachments.saveImages = async (inputs) =>
    (await originalSave(inputs)).map((image) => ({
      ...image,
      bytes: portrait.length + 2,
    }));
  await assert.rejects(
    () => attachVisualPage(f.attachments, f.root, f.visual),
    { code: "VISUAL_ATTACHMENT_LIMIT" },
  );
});

test("one read tool call automatically chooses unified visual work and attaches its first image page", async () => {
  const f = fixture();
  const tools = new Map();
  let dispose;
  let calls = 0;
  const previous = Service.prototype.readVisual;
  Service.prototype.readVisual = async function () {
    calls++;
    return {
      taskId: "synthetic-task",
      usage: { requests: 4 },
      result: {
        id: "synthetic-reading",
        bvid: "BV0000000001",
        page: 1,
        cid: 7,
        duration: 60,
        route: "none",
        segments: [],
        coverage: { state: "no_subtitles" },
        visual: f.visual,
      },
    };
  };
  try {
    plugin.apply(
      {
        ...f.ctx,
        tools: {
          register(tool) {
            tools.set(tool.name, tool);
          },
        },
        effect(setup) {
          dispose = setup();
        },
      },
      { dataDir: f.root, enableDailyFetching: false },
    );
    const tool = tools.get("bili_humanism_read");
    const value = await tool.execute({ video: "BV0000000001" }, f.exec);
    const parsed = JSON.parse(value);
    assert.equal(calls, 1);
    assert.equal(parsed.visual.status, "frames_ready");
    assert.equal(parsed.usage.requests, 4);
    assert.equal(
      tool.output.render({}, value).filter((b) => b.type === "image").length,
      1,
    );
    assert.equal(parsed.result.visual, undefined);
    assert.ok(!value.includes(JSON.stringify(f.path).slice(1, -1)));
  } finally {
    dispose?.();
    if (previous) Service.prototype.readVisual = previous;
    else delete Service.prototype.readVisual;
  }
});
