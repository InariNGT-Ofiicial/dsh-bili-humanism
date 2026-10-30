import { wbiNav } from "./fixtures/wbi.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Service } from "../lib/service.mjs";
import { temporaryVideo, videoTrack } from "../lib/visual-media.mjs";
import { safeError } from "../lib/errors.mjs";

const cdn = "https://synthetic.bilivideo.com/video.mp4";
const track = {
  id: 32,
  width: 852,
  height: 480,
  bandwidth: 100000,
  baseUrl: cdn,
};
const json = (data) => new Response(JSON.stringify(data), { status: 200 });
const worker = `
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [scenario,kind,...args]=process.argv.slice(2);
if(kind==='doctor') {console.log(JSON.stringify({status:scenario==='no-deps'?'dependencies_unavailable':'ready'}));process.exit(scenario==='no-deps'?2:0);}
const [mode,input,output]=args;
if(!existsSync(input))process.exit(8);
mkdirSync(output,{recursive:true});writeFileSync(join(output,'started.json'),JSON.stringify({input}));
if(scenario==='hold')setInterval(()=>{},1000);
else if(scenario==='fail')process.exit(9);
else {
 const frames=[];
 for(let i=0;i<5;i++) {const file='frame-00'+i+'-'+i+'.00.jpg';writeFileSync(join(output,file),Buffer.from([255,216,255,217]));frames.push({at:i,file,width:160,height:96});}
 writeFileSync(join(output,'manifest.json'),JSON.stringify({route:'frame',duration:4,sampling:'synthetic',frames}));
}
`;

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "humanism-visual-")));
  const dataDir = join(root, "private"),
    calls = [],
    children = [];
  const script = join(root, "worker.mjs");
  writeFileSync(script, worker);
  const service = new Service(
    { dataDir, ...(options.limits ? { limits: options.limits } : {}) },
    {
      fetcher: async (url, request) => {
        calls.push({ url: String(url), request });
        const path = new URL(url).pathname;
        if (options.fetcher) return options.fetcher(url, request, path);
        if (path === "/x/web-interface/view")
          return json({
            code: 0,
            data: {
              title: "Synthetic source",
              owner: { mid: 1, name: "Synthetic Author" },
              pages: [{ page: 1, cid: 7, duration: 4 }],
            },
          });
        if (path === "/x/web-interface/nav") return json(wbiNav);
        if (path === "/x/player/wbi/v2")
          return json({ code: 0, data: { subtitle: { subtitles: [] } } });
        if (path === "/x/player/playurl")
          return json({
            code: 0,
            data: options.data || { quality: 32, dash: { video: [track] } },
          });
        if (path === "/video.mp4")
          return (
            options.media?.() || new Response("SYNTHETIC_DOWNLOADED_VIDEO")
          );
        assert.fail("Unexpected synthetic request");
      },
      spawn: (executable, argv, settings) => {
        const doctor = basename(argv[0]) === "frame_environment.py";
        if (options.spawn && !doctor)
          return options.spawn(executable, argv, settings);
        if (!doctor) children.push({ input: argv[2], output: argv[3], argv });
        return spawn(
          process.execPath,
          [
            script,
            options.scenario || "success",
            doctor ? "doctor" : "media",
            ...argv.slice(1),
          ],
          settings,
        );
      },
    },
  );
  const reading = service.store.saveReading({
    bvid: "BV0000000001",
    page: 1,
    cid: 7,
    duration: options.duration || 4,
    route: "none",
    segments: [],
    coverage: { state: "no_subtitles", speech: "unknown" },
  });
  t.after(() => service.close());
  return { root, dataDir, service, reading, calls, children };
}
const visual = (f, signal) => f.service.visual(f.reading.id, signal);
function cleaned(f) {
  const parent = join(f.dataDir, "media-intermediates");
  if (existsSync(parent)) assert.deepEqual(readdirSync(parent), []);
  for (const child of f.children) assert.equal(existsSync(child.input), false);
}
async function started(f) {
  for (let i = 0; i < 300; i++) {
    if (f.children[0] && existsSync(join(f.children[0].output, "started.json")))
      return;
    await delay(10);
  }
  assert.fail("Synthetic decoder did not start");
}

test("480p selection chooses bounded DASH including portrait and rejects fake dimensions/bitrates/quality", () => {
  assert.equal(
    videoTrack({ dash: { video: [{ ...track, id: 64, height: 720 }, track] } })
      .quality,
    32,
  );
  assert.equal(
    videoTrack({ dash: { video: [{ ...track, width: 480, height: 852 }] } })
      .height,
    852,
  );
  for (const patch of [
    { height: undefined },
    { height: NaN },
    { width: Infinity },
    { width: 1921 },
    { width: 720, height: 1280 },
    { bandwidth: 0 },
    { bandwidth: Infinity },
    { id: 64 },
    { id: "32" },
  ])
    assert.throws(
      () => videoTrack({ dash: { video: [{ ...track, ...patch }] } }),
      (e) => e.code === "VIDEO_480P_UNAVAILABLE",
    );
  const durl = { quality: 32, durl: [{ url: cdn, size: 100, length: 4000 }] };
  assert.equal(videoTrack(durl).transport, "durl");
  for (const invalid of [
    { ...durl, quality: 64 },
    { ...durl, durl: [...durl.durl, ...durl.durl] },
    { ...durl, durl: [{ url: cdn, size: 33 * 1024 * 1024, length: 4000 }] },
  ])
    assert.throws(() => videoTrack(invalid));
});

test("visual downloads qn32 under the fixed API, retains final frames/hash index and removes only its video", async (t) => {
  const f = fixture(t),
    keep = join(f.root, "user-original-480p.mp4");
  writeFileSync(keep, "KEEP_ORIGINAL");
  const result = await visual(f);
  cleaned(f);
  assert.equal(readFileSync(keep, "utf8"), "KEEP_ORIGINAL");
  assert.equal(new URL(f.calls[0].url).searchParams.get("qn"), "32");
  assert.equal(result.usage.requests, 2);
  assert.ok(
    f.calls.every(
      (call) =>
        call.request.method === "GET" && call.request.redirect === "manual",
    ),
  );
  assert.equal(f.calls[1].request.headers.Cookie, undefined);
  assert.equal(result.result.frames.length, 4);
  assert.equal(result.result.nextOffset, 4);
  assert.equal(result.result.coverage.state, "sampled_frames");
  assert.equal(result.result.intermediateVideo, "removed");
  assert.equal(result.result.frames[0].bytes, 4);
  assert.match(result.result.frames[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(existsSync(join(f.children[0].output, "manifest.json")));
  assert.ok(f.children[0].argv.includes("--strict-duration"));
  const page = f.service.visualFrames(f.reading.id, 4);
  assert.equal(page.frames.length, 1);
  assert.equal(page.nextOffset, null);
});

test("durl single segment uses the same bounded decoder and cleans its intermediate", async (t) => {
  const f = fixture(t, {
    data: { quality: 32, durl: [{ url: cdn, size: 100, length: 4000 }] },
  });
  assert.equal((await visual(f)).result.transport, "durl");
  cleaned(f);
});

test("CDN candidates preserve selected quality and dimensions, include backups, deduplicate and remain bounded", () => {
  const backup = "https://backup.bilivideo.com/video.mp4";
  const selected = videoTrack({
    dash: {
      video: [
        { ...track, backupUrl: [cdn, backup], backup_url: [backup] },
        {
          ...track,
          base_url: "https://other.bilivideo.com/video.mp4",
          baseUrl: undefined,
        },
        {
          ...track,
          id: 16,
          baseUrl: "https://other-quality.bilivideo.com/video.mp4",
        },
        {
          ...track,
          width: 640,
          baseUrl: "https://other-size.bilivideo.com/video.mp4",
        },
      ],
    },
  });
  assert.deepEqual(selected.alternatives, [
    backup,
    "https://other.bilivideo.com/video.mp4",
  ]);
  assert.equal(
    videoTrack({
      dash: {
        video: [
          {
            ...track,
            backupUrl: Array.from(
              { length: 100 },
              (_, n) => `https://cdn${n}.bilivideo.com/video.mp4`,
            ),
          },
        ],
      },
    }).alternatives.length,
    5,
  );
  assert.deepEqual(
    videoTrack({
      quality: 32,
      durl: [{ url: cdn, size: 100, length: 4000, backup_url: [backup] }],
    }).alternatives,
    [backup],
  );
});

test("visual recovers a reset first CDN using a same-quality backup within the shared budget", async (t) => {
  let attempts = 0;
  const backup = "https://backup.mcdn.bilivideo.cn:8082/video.mp4";
  const f = fixture(t, {
    data: { dash: { video: [{ ...track, backupUrl: [backup] }] } },
    media: () => {
      if (++attempts <= 3) throw new Error("synthetic reset");
      return new Response("SYNTHETIC_VIDEO");
    },
  });
  const result = await visual(f);
  assert.equal(result.usage.requests, 5);
  assert.deepEqual(
    f.calls.slice(1).map((call) => call.url),
    [cdn, cdn, cdn, backup],
  );
  assert.ok(
    f.calls.slice(1).every((call) => call.request.headers.Cookie === undefined),
  );
  assert.equal(result.result.quality, 32);
  cleaned(f);
});

test("visual skips denied URLs and falls back after HTTP or body transport failure without allowing new hosts", async (t) => {
  for (const mode of ["denied", "malformed", "http", "body"]) {
    let attempts = 0;
    const f = fixture(t, {
      data: {
        dash: {
          video: [
            {
              ...track,
              baseUrl:
                mode === "denied"
                  ? "https://synthetic.edge.mountaintoys.cn:4483/video.mp4"
                  : mode === "malformed"
                    ? "invalid"
                    : cdn,
              backup_url: ["https://backup.bilivideo.com/video.mp4"],
            },
          ],
        },
      },
      media: () => {
        if (++attempts === 1 && mode === "http")
          return new Response("", { status: 500 });
        if (attempts === 1 && mode === "body")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("PRIVATE_BODY_ERROR"));
              },
            }),
          );
        return new Response("SYNTHETIC_VIDEO");
      },
    });
    const result = await visual(f);
    assert.equal(
      result.usage.requests,
      ["denied", "malformed"].includes(mode) ? 2 : 3,
    );
    assert.equal(new URL(f.calls.at(-1).url).hostname, "backup.bilivideo.com");
    cleaned(f);
  }
});

test("visual CDN fallback stops on platform risk, oversized response and exhausted request budget", async (t) => {
  for (const mode of ["risk", "large", "budget"]) {
    const f = fixture(t, {
      data: {
        dash: {
          video: [
            { ...track, backupUrl: ["https://backup.bilivideo.com/video.mp4"] },
          ],
        },
      },
      ...(mode === "budget" ? { limits: { requests: 2 } } : {}),
      media: () => {
        if (mode === "risk") return new Response("", { status: 412 });
        if (mode === "large")
          return new Response("", {
            headers: { "content-length": String(33 * 1024 * 1024) },
          });
        throw new Error("synthetic reset");
      },
    });
    await assert.rejects(
      visual(f),
      (error) =>
        error.code ===
        {
          risk: "PLATFORM_PAUSED",
          large: "RESPONSE_TOO_LARGE",
          budget: "REQUESTS_BUDGET",
        }[mode],
    );
    assert.equal(f.calls.length, 2);
    assert.equal(f.service.store.getControl("visual:" + f.reading.id), null);
    if (mode === "risk") assert.ok(f.service.store.getControl("pause"));
    cleaned(f);
  }
});

test("dependency preflight, missing reading, duration and prior cancellation refuse before download", async (t) => {
  const missing = fixture(t, { scenario: "no-deps" });
  await assert.rejects(
    visual(missing),
    (e) => e.code === "FRAME_DEPENDENCIES_UNAVAILABLE",
  );
  assert.equal(missing.calls.length, 0);
  cleaned(missing);
  const f = fixture(t);
  await assert.rejects(f.service.visual("missing-reading"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    visual(f, controller.signal),
    (e) => e.code === "CANCELLED",
  );
  assert.equal(f.calls.length, 0);
  cleaned(f);
  const long = fixture(t, { duration: 601, limits: { asrSeconds: 600 } });
  await assert.rejects(visual(long), (e) => e.code === "MEDIA_DURATION_BUDGET");
  assert.equal(long.calls.length, 0);
  cleaned(long);
});

test("decoder failure, spawn error and synchronous startup failure still remove owned video", async (t) => {
  const failed = fixture(t, { scenario: "fail" });
  await assert.rejects(visual(failed), (e) => e.code === "LOCAL_MEDIA_FAILED");
  cleaned(failed);
  const missing = fixture(t, {
    spawn: (_exe, _args, settings) =>
      spawn(join(tmpdir(), "nonexistent-visual-executable"), [], settings),
  });
  await assert.rejects(
    visual(missing),
    (e) => e.code === "LOCAL_MEDIA_DEPENDENCY_FAILED",
  );
  cleaned(missing);
  const sentinel = new Error("SYNTHETIC_STARTUP_FAILURE");
  const synchronous = fixture(t, {
    spawn: () => {
      throw sentinel;
    },
  });
  await assert.rejects(visual(synchronous), (e) => e === sentinel);
  cleaned(synchronous);
});

test("running decoder abort and task timeout wait for child close then clean video", async (t) => {
  const abort = fixture(t, { scenario: "hold" }),
    controller = new AbortController();
  const rejected = assert.rejects(
    visual(abort, controller.signal),
    (e) => e.code === "CANCELLED",
  );
  await started(abort);
  controller.abort();
  await rejected;
  cleaned(abort);
  const timeout = fixture(t, { scenario: "hold", limits: { wallMs: 1200 } });
  await assert.rejects(visual(timeout), (e) => e.code === "WALL_BUDGET");
  cleaned(timeout);
});

test("partial media failure and oversized/redirected media clean the pre-owned file", async (t) => {
  const responses = [
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.error(new Error("SYNTHETIC_STREAM_FAILURE"));
          },
        }),
      ),
    () =>
      new Response("", {
        headers: { "content-length": String(33 * 1024 * 1024) },
      }),
    () =>
      new Response("", {
        status: 302,
        headers: { location: "https://other.example/video" },
      }),
  ];
  for (const media of responses) {
    const f = fixture(t, { media });
    await assert.rejects(visual(f));
    cleaned(f);
    assert.equal(f.service.store.getControl("visual:" + f.reading.id), null);
  }
});

test("invalid media URL and platform risk stop without bypass and clear only the owned temporary file", async (t) => {
  const denied = fixture(t, {
    data: {
      dash: { video: [{ ...track, baseUrl: "https://127.0.0.1/private" }] },
    },
  });
  await assert.rejects(visual(denied), (e) => e.code === "URL_DENIED");
  cleaned(denied);
  assert.equal(denied.calls.length, 1);
  const paused = fixture(t, {
    fetcher: () => new Response("", { status: 412 }),
  });
  await assert.rejects(visual(paused), (e) => e.code === "PLATFORM_PAUSED");
  cleaned(paused);
  assert.equal(paused.service.store.status().pause.reason, "HTTP_412");
});

test("auto text+visual read shares a single request budget and cached frames survive restart", async (t) => {
  const f = fixture(t);
  const combined = await f.service.readVisual("BV0000000001");
  assert.equal(combined.usage.requests, 5);
  assert.equal(combined.result.visual.status, "sampled_frames");
  assert.equal(f.service.store.status().tasks.length, 1);
  const cached = await f.service.readVisual("BV0000000001");
  assert.equal(cached.usage.requests, 3); // Empty text is rechecked; saved frames are reused.
  assert.equal(cached.result.visual.frameCount, 5);
  f.service.close();
  const reopened = new Service({ dataDir: f.dataDir });
  t.after(() => reopened.close());
  assert.equal(reopened.visualFrames(combined.result.id, 4).frames.length, 1);
  const budget = fixture(t, { limits: { requests: 3 } });
  await assert.rejects(
    budget.service.readVisual("BV0000000001"),
    (e) => e.code === "REQUESTS_BUDGET",
  );
  cleaned(budget);
});

test("auto read can return text with explicit unavailable images but never swallows platform pause", async (t) => {
  const f = fixture(t, { scenario: "no-deps" });
  const result = await f.service.readVisual("BV0000000001");
  assert.equal(result.result.visual.status, "unavailable");
  assert.equal(result.result.visual.error, "FRAME_DEPENDENCIES_UNAVAILABLE");
  assert.equal(f.calls.length, 3);
  const paused = fixture(t);
  paused.service.fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/x/web-interface/view")
      return json({
        code: 0,
        data: { owner: { mid: 1 }, pages: [{ page: 1, cid: 7, duration: 4 }] },
      });
    if (path === "/x/web-interface/nav") return json(wbiNav);
    if (path === "/x/player/wbi/v2") return json({ code: 0, data: {} });
    return new Response("", { status: 412 });
  };
  await assert.rejects(
    paused.service.readVisual("BV0000000001"),
    (e) => e.code === "PLATFORM_PAUSED",
  );
  assert.ok(paused.service.store.status().pause);
  cleaned(paused);
});

test("persistent frame reads reject modified files and invalid offsets", async (t) => {
  const f = fixture(t),
    result = await visual(f);
  writeFileSync(result.result.frames[0].path, "REPLACED_IMAGE");
  assert.throws(
    () => f.service.visualFrames(f.reading.id),
    (e) => e.code === "VISUAL_IMAGE_CHANGED",
  );
  assert.throws(
    () => f.service.visualFrames(f.reading.id, -1),
    (e) => e.code === "INVALID_VISUAL_OFFSET",
  );
});

test("temporary ownership refuses a replaced file without deleting the replacement", (t) => {
  const f = fixture(t),
    owned = temporaryVideo(f.dataDir);
  owned.write(Buffer.from("OWNED_VIDEO"));
  const parked = join(dirname(owned.path), "parked.mp4");
  renameSync(owned.path, parked);
  writeFileSync(owned.path, "UNRELATED_REPLACEMENT");
  assert.throws(
    () => owned.cleanup(),
    (e) => e.code === "VISUAL_CLEANUP_REFUSED",
  );
  assert.equal(readFileSync(owned.path, "utf8"), "UNRELATED_REPLACEMENT");
  assert.equal(readFileSync(parked, "utf8"), "OWNED_VIDEO");
});

test("cleanup refusal never commits a successful frame index or hides a prior failure", async (t) => {
  let substituted;
  const f = fixture(t, {
    spawn: (_exe, argv, settings) => {
      substituted = argv[2];
      renameSync(
        substituted,
        join(dirname(substituted), "parked-owned-video.mp4"),
      );
      writeFileSync(substituted, "UNRELATED_REPLACEMENT");
      const script = join(f.root, "worker.mjs");
      return spawn(
        process.execPath,
        [script, "success", "media", ...argv.slice(1)],
        settings,
      );
    },
  });
  await assert.rejects(visual(f), (e) => e.code === "VISUAL_CLEANUP_FAILED");
  assert.equal(f.service.store.getControl("visual:" + f.reading.id), null);
  assert.equal(readFileSync(substituted, "utf8"), "UNRELATED_REPLACEMENT");
  const sentinel = new Error("SYNTHETIC_PROCESSING_FAILED");
  const failed = fixture(t, {
    spawn: (_exe, argv) => {
      renameSync(argv[2], join(dirname(argv[2]), "parked-owned-video.mp4"));
      writeFileSync(argv[2], "KEEP_REPLACEMENT");
      throw sentinel;
    },
  });
  await assert.rejects(visual(failed), (e) => e === sentinel);
  assert.equal(safeError(sentinel).mediaCleanup, "refused_or_failed");
  assert.equal(
    failed.service.store.getControl("visual:" + failed.reading.id),
    null,
  );
});

test("ordinary local-frames still preserves the user input and uses configured interpreter", async (t) => {
  const f = fixture(t),
    input = join(f.root, "original.mp4");
  writeFileSync(input, "KEEP_ORIGINAL");
  const result = await f.service.localMedia("frames", f.reading.id, input);
  assert.equal(result.result.status, "sampled_frames");
  assert.equal(readFileSync(input, "utf8"), "KEEP_ORIGINAL");
  assert.throws(
    () =>
      new Service({
        dataDir: join(f.root, "invalid-config"),
        pythonPath: "relative-python",
      }),
    (e) => e.code === "INVALID_PYTHON_PATH",
  );
});
