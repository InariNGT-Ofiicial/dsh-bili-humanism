import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Fault } from "../lib/errors.mjs";
import { Service } from "../lib/service.mjs";
import {
  chosenTimes,
  spreadOrder,
} from "../lib/visual-media.mjs";
import { renderReadingText } from "../lib/visual-output.mjs";
import { Config, apply } from "../index.js";
import { wbiNav } from "./fixtures/wbi.mjs";

const bv = "BV0000000001";
const json = (data) => new Response(JSON.stringify(data), { status: 200 });
const times = (...at) => at.map((value) => ({ at: value }));
const uniform = (count, step = 15) =>
  times(...Array.from({ length: count }, (_, index) => index * step));
const pages = (order, size = 4) =>
  Array.from({ length: Math.ceil(order.length / size) }, (_, page) =>
    order.slice(page * size, (page + 1) * size),
  );
const permutation = (order, count) =>
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    Array.from({ length: count }, (_, index) => index),
  );

test("spreadOrder keeps four frames or fewer chronological", () => {
  assert.deepEqual(spreadOrder([]), []);
  assert.deepEqual(spreadOrder(times(5)), [0]);
  assert.deepEqual(spreadOrder(uniform(4)), [0, 1, 2, 3]);
  assert.deepEqual(spreadOrder(times(30, 10, 20)), [1, 2, 0]);
  assert.deepEqual(
    spreadOrder(times(30, 10), { priorities: [30], duration: 60 }),
    [1, 0],
  );
});

test("spreadOrder page one takes the frames nearest the quarter centres", () => {
  const order = spreadOrder(uniform(40), { duration: 600 });
  assert.deepEqual(order.slice(0, 4), [5, 15, 25, 35]);
  permutation(order, 40);
  // Without a duration the last frame bounds the timeline.
  assert.deepEqual(spreadOrder(uniform(41)).slice(0, 4), [5, 15, 25, 35]);
});

test("spreadOrder spreads every page and later pages fill the largest gaps", () => {
  const frames = uniform(40);
  const order = spreadOrder(frames, { duration: 600 });
  const seen = [];
  const largestGap = () => {
    const line = [
      0,
      ...seen.map((i) => frames[i].at).sort((a, b) => a - b),
      600,
    ];
    return Math.max(...line.slice(1).map((at, i) => at - line[i]));
  };
  const gaps = [];
  for (const page of pages(order)) {
    const at = page.map((i) => frames[i].at);
    assert.deepEqual(
      at,
      [...at].sort((a, b) => a - b),
      "pages read in time order",
    );
    // Sampling every 15 s, the last pages can only hold what is left.
    if (seen.length < 24)
      assert.ok(
        at.at(-1) - at[0] >= 300,
        `page ${at} covers half the timeline`,
      );
    seen.push(...page);
    gaps.push(largestGap());
  }
  assert.deepEqual(gaps.slice(0, 2), [150, 75]);
  assert.ok(gaps.every((gap, i) => i === 0 || gap <= gaps[i - 1]));
});

test("spreadOrder stays spread when sampled times wobble", () => {
  const wobbling = uniform(40).map(({ at }, index) => ({
    at: at + (index % 3) * 0.04,
  }));
  const order = spreadOrder(wobbling, { duration: 600 });
  permutation(order, 40);
  for (const page of pages(order).slice(0, 5)) {
    const at = page.map((i) => wobbling[i].at);
    assert.ok(at.at(-1) - at[0] >= 300, String(at));
  }
});

test("spreadOrder lets the strongest priority of a quarter replace its centre, on page one only", () => {
  const frames = uniform(40);
  const plain = spreadOrder(frames, { duration: 600 });
  const order = spreadOrder(frames, {
    // 400 is the strongest of the third quarter; 370 and the other times lose to it.
    priorities: [400, 20, 370, -5, 601, NaN, 40],
    duration: 600,
  });
  assert.deepEqual(order.slice(0, 4), [1, 15, 27, 35]);
  permutation(order, 40);
  const strongLate = spreadOrder(frames, { priorities: [75], duration: 600 });
  assert.deepEqual(strongLate.slice(0, 4), plain.slice(0, 4));
  // The boundaries belong to the later quarter; the end to the last one.
  assert.deepEqual(
    spreadOrder(frames, { priorities: [150, 600], duration: 600 }).slice(0, 4),
    [5, 10, 25, 39],
  );
});

test("spreadOrder keeps every index once on sparse and clumped timelines", () => {
  for (const frames of [
    times(0, 1, 2, 3, 100),
    times(0, 0, 0, 0, 0, 0),
    times(98, 99, 100, 101, 102, 103, 104),
    times(0, 1, 2, 3, 4, 5, 6, 7, 8, 590),
  ]) {
    permutation(spreadOrder(frames, { duration: 600 }), frames.length);
    permutation(
      spreadOrder(frames, { priorities: [99, 1, 1], duration: 600 }),
      frames.length,
    );
    permutation(spreadOrder(frames), frames.length);
  }
  assert.deepEqual(
    spreadOrder(times(0, 0, 0, 0, 0), { priorities: [0] }).sort(),
    [0, 1, 2, 3, 4],
  );
  // A priority keeps its frame even when a centre would be nearer to it too.
  assert.ok(
    spreadOrder(times(10, 500, 501, 502, 503), {
      priorities: [450],
      duration: 600,
    })
      .slice(0, 4)
      .includes(1),
  );
});

test("chosenTimes accepts 1-4 finite seconds within the duration only", () => {
  assert.deepEqual(chosenTimes([0, 12.5, 60], 60), [0, 12.5, 60]);
  for (const at of [
    undefined,
    null,
    "12",
    12,
    [],
    [1, 2, 3, 4, 5],
    [-1],
    [60.01],
    [NaN],
    [Infinity],
    ["12"],
    [null],
    [{}],
  ])
    assert.throws(() => chosenTimes(at, 60), { code: "VISUAL_AT_INVALID" });
});

const worker = `
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [scenario,kind,...args]=process.argv.slice(2);
if(kind==='doctor'){console.log(JSON.stringify({status:scenario==='no-deps'?'dependencies_unavailable':'ready'}));process.exit(0);}
const [mode,input,output]=args;
const flag=(name)=>args.includes(name)?args[args.indexOf(name)+1]:null;
const duration=Number(flag('--duration'));
if(!existsSync(input))process.exit(8);
if(scenario==='fail')process.exit(9);
if(scenario==='litter'){writeFileSync(input+'.extra','x');process.exit(9);}
if(scenario==='hold')setInterval(()=>{},1000);
else if(mode==='asr'&&scenario==='garbled')writeFileSync(output,'not json');
else if(mode==='asr'&&scenario==='no-output'){}
else if(mode==='asr'&&scenario==='not-a-list')writeFileSync(output,JSON.stringify({segments:'nope'}));
else if(mode==='asr'&&scenario==='backwards')writeFileSync(output,JSON.stringify({segments:[{start:10,end:5,text:'倒退'}]}));
else if(mode==='asr'){
 if(scenario==='slow')await new Promise((done)=>setTimeout(done,900));
 const text=scenario==='short'?'短':scenario==='empty'?'':'一段合成的本地转写文字，比已有文字更长。';
 writeFileSync(output,JSON.stringify({route:'A3',duration,segments:[{start:0,end:duration,text}]}));
}
else {
 mkdirSync(output,{recursive:true});
 const at=flag('--at');
 const stamps=at?at.split(',').map(Number):Array.from({length:40},(_,i)=>i*duration/40);
 const frames=stamps.map((t,i)=>{const file='frame-'+String(i).padStart(3,'0')+'-'+t.toFixed(2)+'.jpg';writeFileSync(join(output,file),Buffer.from([255,216,255,217,i]));return {at:t,file,width:160,height:96};});
 writeFileSync(join(output,'manifest.json'),JSON.stringify({route:'frame',duration,sampling:at?(scenario==='unchosen'?'uniform':'chosen'):'uniform',frames}));
}
`;

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "humanism-moment-")));
  const script = join(root, "worker.mjs");
  writeFileSync(script, worker);
  const calls = [],
    children = [],
    doctors = [];
  const state = { scenario: options.scenario || "success" };
  const service = new Service(
    {
      dataDir: join(root, "private"),
      asrModelPath: root,
      autoAsr: true,
      ...options.config,
    },
    {
      fetcher: async (url) => {
        calls.push(String(url));
        const path = new URL(url).pathname;
        if (options.fetcher) return options.fetcher(path, url);
        if (path === "/x/player/playurl")
          return json({
            code: 0,
            data: {
              quality: 32,
              dash: {
                video: [
                  {
                    id: 32,
                    width: 852,
                    height: 480,
                    bandwidth: 1000,
                    baseUrl: "https://synthetic.bilivideo.com/video.mp4",
                  },
                ],
                audio: [
                  {
                    bandwidth: 900,
                    baseUrl: "https://synthetic.bilivideo.com/high.m4s",
                  },
                  {
                    bandwidth: 300,
                    baseUrl: "https://synthetic.bilivideo.com/low.m4s",
                  },
                ],
              },
            },
          });
        if (path === "/low.m4s" || path === "/video.mp4")
          return options.media?.() || new Response("SYNTHETIC_MEDIA");
        assert.fail("Unexpected synthetic request");
      },
      spawn: (_executable, argv, settings) => {
        const doctor = ["frame_environment.py", "asr_environment.py"].includes(
          basename(argv[0]),
        );
        (doctor ? doctors : children).push(argv);
        return spawn(
          process.execPath,
          [
            script,
            state.scenario,
            doctor ? "doctor" : "media",
            ...argv.slice(1),
          ],
          settings,
        );
      },
    },
  );
  t.after(() => service.close());
  const seed = (overrides = {}) =>
    service.store.saveReading({
      bvid: bv,
      page: 1,
      cid: 7,
      title: "合成标题",
      duration: 600,
      route: "none",
      segments: [],
      coverage: { state: "read_failed", speech: "unknown" },
      attempts: [
        { route: "A1", state: "empty_unconfirmed" },
        { route: "A3", state: "local_import_available", note: "synthetic" },
      ],
      ...overrides,
    });
  const clean = () => {
    const parent = join(service.store.root, "media-intermediates");
    if (existsSync(parent)) assert.deepEqual(readdirSync(parent), []);
  };
  return { root, service, calls, children, doctors, seed, clean, state };
}
const flag = (argv, name) => argv[argv.indexOf(name) + 1];
const autoEntry = ({ attempts }) =>
  attempts.filter(
    ({ route, state }) => route === "A3" && state.startsWith("auto_"),
  );
const partial = (end = 100, text = "开头") => ({
  route: "A1",
  segments: [{ start: 0, end, text, source: "A1" }],
  coverage: { state: "partial", speech: "unknown" },
});

test("visual pages spread over the order, sorted by time, and offsets stay positions in it", async (t) => {
  const f = fixture(t, { config: { autoAsr: false } });
  const reading = f.seed();
  const first = (await f.service.visual(reading.id)).result;
  assert.equal(first.frameCount, 40);
  assert.equal(first.frameOffset, 0);
  assert.equal(first.nextOffset, 4);
  assert.deepEqual(
    first.frames.map(({ at }) => at),
    [75, 225, 375, 525],
  );
  const manifest = f.service.store.getControl("visual:" + reading.id);
  const seen = first.frames.map(({ file }) => file);
  for (let offset = 4; offset !== null; ) {
    const page = f.service.visualFrames(reading.id, offset);
    assert.equal(page.frameOffset, offset);
    const at = page.frames.map((frame) => frame.at);
    assert.deepEqual(
      at,
      [...at].sort((a, b) => a - b),
    );
    seen.push(...page.frames.map(({ file }) => file));
    offset = page.nextOffset;
  }
  assert.equal(new Set(seen).size, 40);
  // A shifted offset is one position further along the same order.
  const shifted = f.service.visualFrames(reading.id, 1);
  const order = manifest.order;
  assert.deepEqual(
    shifted.frames.map(({ file }) => file).sort(),
    order
      .slice(1, 5)
      .map((index) => manifest.manifest.frames[index].file)
      .sort(),
  );
  assert.equal(shifted.nextOffset, 5);
});

test("cached danmaku peaks steer page one and the persisted order survives later danmaku", async (t) => {
  const f = fixture(t, { config: { autoAsr: false } });
  const reading = f.seed();
  const rows = (at, n) =>
    Array.from({ length: n }, (_, i) => [at + i * 0.1, "同一句", 0]);
  const quiet = Array.from({ length: 60 }, (_, i) => [
    i * 10 + 3,
    "零散" + i,
    0,
  ]);
  f.service.store.setControl("danmaku:" + reading.id, {
    total: 80,
    rows: [...quiet, ...rows(30, 12), ...rows(120, 6), ...rows(410, 9)],
  });
  assert.deepEqual(
    f.service.danmakuPeakTimes(reading.id, 600),
    [30.7, 410.7, 120.6],
  );
  const first = (await f.service.visual(reading.id)).result;
  // Frames sit every 15 s. The first quarter takes 30 over 120, the third takes 405.
  assert.deepEqual(
    first.frames.map(({ at }) => at),
    [30, 225, 405, 525],
  );
  const stored = f.service.store.getControl("visual:" + reading.id).order;
  f.service.store.setControl("danmaku:" + reading.id, {
    total: 9,
    rows: rows(300, 9),
  });
  assert.deepEqual(
    f.service.visualFrames(reading.id).frames.map(({ at }) => at),
    [30, 225, 405, 525],
  );
  assert.deepEqual(
    f.service.store.getControl("visual:" + reading.id).order,
    stored,
  );
});

test("danmaku arriving after page one changes neither pages nor offsets", async (t) => {
  const f = fixture(t, { config: { autoAsr: false } });
  const reading = f.seed();
  const before = (await f.service.visual(reading.id)).result.frames;
  f.service.store.setControl("danmaku:" + reading.id, {
    total: 9,
    rows: Array.from({ length: 9 }, (_, i) => [31 + i * 0.1, "晚到", 0]),
  });
  assert.deepEqual(f.service.visualFrames(reading.id).frames, before);
});

test("an index stored by an older version pages by the spread order and gains it once", async (t) => {
  const f = fixture(t, { config: { autoAsr: false } });
  const reading = f.seed();
  await f.service.visual(reading.id);
  const key = "visual:" + reading.id;
  const { order, ...old } = f.service.store.getControl(key);
  for (const legacy of [
    old,
    { ...old, order: [0, 0] },
    { ...old, order: "x" },
  ]) {
    f.service.store.setControl(key, legacy);
    assert.deepEqual(
      f.service.visualFrames(reading.id).frames.map(({ at }) => at),
      [75, 225, 375, 525],
    );
    assert.deepEqual(f.service.store.getControl(key).order, order);
  }
  assert.equal(f.service.visualFrames(reading.id, 36).nextOffset, null);
});

test("at passes chosen times to the same bounded decoder, stores apart and keeps the output shape", async (t) => {
  const f = fixture(t, {
    config: { autoAsr: false, limits: { wallMs: 60000 } },
  });
  const reading = f.seed();
  const sampled = (await f.service.visual(reading.id)).result;
  const index = f.service.store.getControl("visual:" + reading.id);
  f.children.length = 0;
  f.calls.length = 0;
  const { result, usage } = await f.service.visualAt(reading.id, [30.5, 12]);
  assert.equal(usage.requests, 2);
  assert.equal(new URL(f.calls[0]).searchParams.get("qn"), "32");
  const argv = f.children[0];
  assert.equal(flag(argv, "--at"), "30.5,12");
  assert.ok(!argv.includes("--interval"));
  assert.ok(argv.includes("--strict-duration"));
  assert.equal(flag(argv, "--max-short-side"), "480");
  assert.equal(flag(argv, "--max-long-side"), "1920");
  assert.equal(flag(argv, "--max-pixels"), "921600");
  assert.ok(argv.includes("--max-wall-seconds"));
  const wall = Number(flag(argv, "--max-wall-seconds"));
  assert.ok(wall > 0 && wall <= 55, String(wall));
  assert.equal(existsSync(argv[2]), false);
  f.clean();
  assert.deepEqual(
    result.frames.map(({ at }) => at),
    [12, 30.5],
  );
  assert.deepEqual(Object.keys(result), Object.keys(sampled));
  assert.equal(result.frameOffset, 0);
  assert.equal(result.frameCount, 2);
  assert.equal(result.nextOffset, null);
  assert.equal(result.intermediateVideo, "removed");
  assert.equal(result.route, "frame");
  assert.match(result.frames[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(result.coverage.note, /chosen moments/);
  assert.match(sampled.coverage.note, /^Uniform sampled/);
  assert.notEqual(result.path, sampled.path);
  assert.deepEqual(f.service.store.getControl("visual:" + reading.id), index);
  assert.equal(
    f.service.store.getControl("visual-at:" + reading.id).directory,
    result.path,
  );
  assert.deepEqual(
    f.service.visualFrames(reading.id).frames.map(({ at }) => at),
    [75, 225, 375, 525],
  );
});

test("the same chosen moments reuse their frames and other moments download again", async (t) => {
  const f = fixture(t, { config: { autoAsr: false } });
  const reading = f.seed();
  const first = (await f.service.visualAt(reading.id, [30.5, 12])).result;
  const requests = f.calls.length;
  const decoders = f.children.length;
  const again = await f.service.visualAt(reading.id, [12, 30.5, 12]);
  assert.equal(f.calls.length, requests);
  assert.equal(f.children.length, decoders);
  assert.equal(again.usage.requests, 0);
  assert.deepEqual(again.result, first);
  await f.service.visualAt(reading.id, [40]);
  assert.ok(f.calls.length > requests);
  // Frames removed by hand are fetched again, not reported as an error.
  const index = f.service.store.getControl("visual-at:" + reading.id);
  rmSync(index.directory, { recursive: true, force: true });
  const calls = f.calls.length;
  await f.service.visualAt(reading.id, [40]);
  assert.ok(f.calls.length > calls);
  f.clean();
});

test("invalid at raises before any request or decoder and a failing decoder leaves no index", async (t) => {
  const f = fixture(t, { config: { autoAsr: false } });
  const reading = f.seed();
  for (const at of [[], [601], [-1], [1, 2, 3, 4, 5], "12", [NaN]])
    await assert.rejects(f.service.visualAt(reading.id, at), {
      code: "VISUAL_AT_INVALID",
    });
  assert.equal(f.calls.length, 0);
  assert.equal(f.children.length, 0);
  f.state.scenario = "fail";
  await assert.rejects(f.service.visualAt(reading.id, [1]), {
    code: "LOCAL_MEDIA_FAILED",
  });
  f.clean();
  assert.equal(f.service.store.getControl("visual-at:" + reading.id), null);
  f.state.scenario = "unchosen";
  await assert.rejects(f.service.visualAt(reading.id, [1]), {
    code: "INVALID_VISUAL_MANIFEST",
  });
  f.clean();
  assert.equal(f.service.store.getControl("visual-at:" + reading.id), null);
});

test("the visual tool takes at and reports invalid input", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "humanism-at-tool-"));
  const tools = new Map();
  let dispose;
  const images = { maxImagesPerMessage: 4, mediaTypes: ["image/jpeg"] };
  apply(
    {
      tools: { register: (tool) => tools.set(tool.name, tool) },
      effect: (setup) => {
        dispose = setup();
      },
      get: (name) =>
        name === "attachments"
          ? { saveImages: async () => [], imageLimits: images }
          : name === "llm"
            ? {
                resolveModelInfo: async () => ({
                  inputModalities: ["text", "image"],
                }),
              }
            : undefined,
    },
    { dataDir: root },
  );
  t.after(() => dispose());
  const exec = {
    agent: { options: { provider: "synthetic", model: "vision" } },
  };
  const tool = tools.get("bili_humanism_visual");
  assert.deepEqual(tool.parameters.properties.at.items, { type: "number" });
  const service = new Service({ dataDir: root });
  t.after(() => service.close());
  const reading = service.store.saveReading({
    bvid: bv,
    page: 1,
    cid: 7,
    duration: 60,
    route: "none",
    segments: [],
    coverage: { state: "read_failed" },
  });
  const value = await tool.execute({ readingId: reading.id, at: [61] }, exec);
  assert.equal(value.error, "VISUAL_AT_INVALID");
});

test("auto ASR is off by default and needs no environment", async (t) => {
  const f = fixture(t, { config: { autoAsr: undefined } });
  const reading = f.seed();
  const result = await f.service.autoAsr(reading.id);
  assert.equal(result.id, reading.id);
  assert.deepEqual(autoEntry(result), []);
  assert.equal(f.calls.length + f.children.length + f.doctors.length, 0);
  assert.deepEqual(f.service.status().media.autoAsr, {
    enabled: false,
    maxSeconds: 1200,
    wallMs: 240000,
  });
  assert.equal(Config({}).autoAsr, false);
  assert.equal(Config({}).autoAsrMaxSeconds, 1200);
  assert.equal(Config({}).autoAsrWallMs, 240000);
});

test("trusted auto ASR config rejects invalid values", (t) => {
  const root = mkdtempSync(join(tmpdir(), "humanism-auto-config-"));
  for (const config of [
    { autoAsr: "yes" },
    { autoAsr: 1 },
    { autoAsrMaxSeconds: 0 },
    { autoAsrMaxSeconds: 1.5 },
    { autoAsrMaxSeconds: "1200" },
    { autoAsrWallMs: -1 },
    { autoAsrWallMs: Infinity },
    { autoAsrWallMs: 2147483648 },
  ])
    assert.throws(() => new Service({ dataDir: root, ...config }), {
      code: "INVALID_AUTO_ASR",
    });
  const accepted = new Service({
    dataDir: root,
    autoAsr: true,
    autoAsrMaxSeconds: 60,
    autoAsrWallMs: 1000,
  });
  t.after(() => accepted.close());
  assert.deepEqual(accepted.status().media.autoAsr, {
    enabled: true,
    maxSeconds: 60,
    wallMs: 1000,
  });
  const widest = new Service({
    dataDir: mkdtempSync(join(tmpdir(), "humanism-auto-config-")),
    autoAsrWallMs: 2147483647,
  });
  t.after(() => widest.close());
  assert.equal(widest.status().media.autoAsr.wallMs, 2147483647);
});

test("auto ASR runs for no text, or text ending before half of at least 60 seconds", async (t) => {
  for (const [name, reading, runs] of [
    ["no text", {}, true],
    ["no text in a short clip", { duration: 30 }, true],
    ["ends early", partial(299.9), true],
    ["ends at half", partial(300), false],
    ["ends late", partial(590), false],
    ["ends early by start time when no end is known", partial(null), true],
    ["short clip ending early", { ...partial(5), duration: 59.9 }, false],
    ["short clip boundary", { ...partial(5), duration: 60 }, true],
    ["A3 already", { ...partial(100), route: "A3" }, false],
  ])
    await t.test(name, async (t) => {
      const f = fixture(t);
      const seeded = f.seed(reading);
      const result = await f.service.autoAsr(seeded.id);
      assert.equal(f.children.length, runs ? 1 : 0);
      assert.equal(result.route, runs ? "A3" : (reading.route ?? "none"));
      if (runs) assert.notEqual(result.id, seeded.id);
      else assert.equal(result.id, seeded.id);
    });
});

test("auto ASR fetches the lowest audio track, passes hints as argv items and saves through the A3 path", async (t) => {
  const f = fixture(t);
  const reading = f.seed();
  const result = await f.service.autoAsr(reading.id);
  assert.deepEqual(
    f.calls.map((call) => new URL(call).pathname),
    ["/x/player/playurl", "/low.m4s"],
  );
  assert.equal(f.children.length, 1);
  const argv = f.children[0];
  assert.equal(argv[1], "asr");
  assert.equal(flag(argv, "--model"), f.root);
  assert.equal(
    flag(argv, "--initial-prompt"),
    "以下是 B 站视频《合成标题》的原始音轨。",
  );
  assert.equal(flag(argv, "--hotwords"), "合成标题");
  assert.ok(argv.includes("--vad"));
  assert.ok(Number(flag(argv, "--max-wall-seconds")) > 90);
  assert.equal(existsSync(argv[2]), false);
  assert.equal(existsSync(argv[3]), false);
  f.clean();
  assert.equal(result.route, "A3");
  assert.notEqual(result.id, reading.id);
  assert.equal(result.coverage.state, "asr_partial");
  assert.equal(
    result.localEvidence,
    "Local AI-ASR, not verbatim. Proper names require source checking.",
  );
  assert.equal(result.segments[0].source, "A3");
  assert.equal(result.tokenBudget.allowed, true);
  assert.deepEqual(autoEntry(result), [{ route: "A3", state: "auto_saved" }]);
  assert.ok(!result.attempts.some((a) => a.state === "local_import_available"));
  const stored = f.service.store.reading(result.id);
  assert.equal(stored.route, "A3");
  assert.deepEqual(autoEntry(stored), [{ route: "A3", state: "auto_saved" }]);
  assert.equal(f.service.store.reading(reading.id).route, "none");
  assert.deepEqual(f.service.store.getControl("auto-asr:" + bv + ":7"), {
    route: "A3",
    state: "auto_saved",
    readingId: result.id,
  });
  assert.equal(f.service.store.status().tasks[0].asr_seconds, 600);
});

test("a hostile title reaches the decoder cleaned, cut and as single argv items", async (t) => {
  for (const [title, expected] of [
    ['--model=/x"; rm -rf /\u0000\u001f\n《》', '--model=/x"; rm -rf /《》'],
    ["长".repeat(121) + "尾", "长".repeat(120)],
    ["😀".repeat(121), "😀".repeat(120)],
  ]) {
    const f = fixture(t);
    await f.service.autoAsr(f.seed({ title }).id);
    assert.equal(flag(f.children[0], "--hotwords"), expected);
    assert.equal(
      flag(f.children[0], "--initial-prompt"),
      `以下是 B 站视频《${expected}》的原始音轨。`,
    );
  }
  const untitled = fixture(t);
  await untitled.service.autoAsr(untitled.seed({ title: "\u0000 " }).id);
  assert.ok(!untitled.children[0].includes("--hotwords"));
  assert.ok(!untitled.children[0].includes("--initial-prompt"));
  assert.ok(untitled.children[0].includes("--vad"));
});

test("a too-long source is skipped without a request, and a later higher limit may run", async (t) => {
  for (const config of [
    { autoAsrMaxSeconds: 599 },
    { maxMediaSeconds: 599 },
    { limits: { asrSeconds: 599 } },
  ]) {
    const f = fixture(t, { config });
    const reading = f.seed();
    const result = await f.service.autoAsr(reading.id);
    assert.equal(result.id, reading.id);
    assert.deepEqual(autoEntry(result), [
      { route: "A3", state: "auto_skipped_duration" },
    ]);
    assert.equal(f.calls.length + f.children.length + f.doctors.length, 0);
    assert.deepEqual(autoEntry(f.service.store.reading(reading.id)), [
      { route: "A3", state: "auto_skipped_duration" },
    ]);
    assert.equal(f.service.store.getControl(`auto-asr:${bv}:7`), null);
    // Repeating adds no second entry.
    const again = await f.service.autoAsr(reading.id);
    assert.equal(autoEntry(again).length, 1);
    assert.equal(again.attempts.length, reading.attempts.length + 1);
  }
  const f = fixture(t, { config: { autoAsrMaxSeconds: 600 } });
  assert.equal((await f.service.autoAsr(f.seed().id)).route, "A3");
});

test("a missing environment or model is reported, not remembered, and spends no request", async (t) => {
  const noModel = fixture(t, { config: { asrModelPath: "" } });
  const reading = noModel.seed();
  const result = await noModel.service.autoAsr(reading.id);
  assert.equal(result.id, reading.id);
  assert.deepEqual(autoEntry(result), [
    { route: "A3", state: "auto_unavailable", error: "ASR_MODEL_MISSING" },
  ]);
  assert.equal(noModel.calls.length, 0);
  assert.equal(
    noModel.service.store.getControl(`auto-asr:${bv}:7`),
    null,
    "installing the model later must help this video",
  );
  const noDeps = fixture(t, { scenario: "no-deps" });
  const broken = noDeps.seed();
  assert.deepEqual(autoEntry(await noDeps.service.autoAsr(broken.id)), [
    {
      route: "A3",
      state: "auto_unavailable",
      error: "ASR_DEPENDENCIES_UNAVAILABLE",
    },
  ]);
  assert.equal(noDeps.calls.length, 0);
  noDeps.state.scenario = "success";
  assert.equal((await noDeps.service.autoAsr(broken.id)).route, "A3");
});

test("a failed download keeps the old text, removes the file and may retry", async (t) => {
  let fail = true;
  const f = fixture(t, {
    media: () => (fail ? new Response("", { status: 500 }) : undefined),
  });
  const reading = f.seed(partial());
  const result = await f.service.autoAsr(reading.id);
  assert.equal(result.id, reading.id);
  assert.equal(result.segments[0].text, "开头");
  assert.deepEqual(autoEntry(result), [
    { route: "A3", state: "auto_unavailable", error: "HTTP_FAILED" },
  ]);
  assert.equal(f.children.length, 0);
  f.clean();
  fail = false;
  assert.equal((await f.service.autoAsr(reading.id)).route, "A3");
});

test("an ASR that ran and failed removes the file and reports the error", async (t) => {
  const f = fixture(t, { scenario: "fail" });
  const failed = await f.service.autoAsr(f.seed().id);
  assert.deepEqual(autoEntry(failed), [
    { route: "A3", state: "auto_unavailable", error: "LOCAL_MEDIA_FAILED" },
  ]);
  assert.equal(existsSync(f.children[0][2]), false);
  f.clean();
});

test("an empty transcript is not better and malformed output is a failure, not text", async (t) => {
  const f = fixture(t, { scenario: "empty" });
  const reading = f.seed();
  const result = await f.service.autoAsr(reading.id);
  assert.deepEqual(autoEntry(result), [
    { route: "A3", state: "auto_not_better" },
  ]);
  assert.equal(result.id, reading.id);
  f.clean();
  const g = fixture(t, { scenario: "garbled" });
  const garbled = g.seed();
  const failed = await g.service.autoAsr(garbled.id);
  assert.equal(failed.id, garbled.id);
  assert.equal(autoEntry(failed)[0].state, "auto_unavailable");
  g.clean();
});

test("the wall budget of auto ASR is its own", async (t) => {
  const long = fixture(t, {
    scenario: "slow",
    config: { limits: { wallMs: 300 } },
  });
  assert.equal((await long.service.autoAsr(long.seed().id)).route, "A3");
  const short = fixture(t, {
    scenario: "hold",
    config: { autoAsrWallMs: 1200 },
  });
  const reading = short.seed();
  const result = await short.service.autoAsr(reading.id);
  assert.deepEqual(autoEntry(result), [
    { route: "A3", state: "auto_unavailable", error: "WALL_BUDGET" },
  ]);
  short.clean();
  assert.equal(result.id, reading.id);
});

test("a transcript no longer than the existing text is kept out and remembered", async (t) => {
  const f = fixture(t, { scenario: "short" });
  const reading = f.seed(partial(100, "已有的文字"));
  const rows = () =>
    f.service.store.db.prepare("SELECT COUNT(*) AS n FROM readings").get().n;
  const before = rows();
  const result = await f.service.autoAsr(reading.id);
  assert.equal(result.id, reading.id);
  assert.equal(result.route, "A1");
  assert.equal(result.segments[0].text, "已有的文字");
  assert.deepEqual(autoEntry(result), [
    { route: "A3", state: "auto_not_better" },
  ]);
  assert.equal(rows(), before);
  f.clean();
  const again = await f.service.autoAsr(reading.id);
  assert.deepEqual(autoEntry(again), [
    { route: "A3", state: "auto_not_better" },
  ]);
  assert.equal(f.children.length, 1);
  assert.equal(f.calls.length, 2);
});

test("equal length is not better; whitespace does not count as text", async (t) => {
  const f = fixture(t, { scenario: "short" });
  const reading = f.seed(partial(100, " 短 "));
  assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [
    { route: "A3", state: "auto_not_better" },
  ]);
});

test("the same video never runs ASR twice and reads again reuse the saved text", async (t) => {
  const f = fixture(t);
  const first = f.seed(partial());
  const saved = await f.service.autoAsr(first.id);
  assert.equal(saved.route, "A3");
  f.calls.length = 0;
  const again = await f.service.autoAsr(first.id);
  assert.equal(again.id, saved.id);
  assert.equal(again.segments[0].text, saved.segments[0].text);
  assert.equal(again.reusedLocalSource, true);
  assert.equal(again.networkSource.route, "A1");
  assert.ok(Array.isArray(again.networkSource.attempts));
  assert.equal(again.networkSource.coverage.state, "partial");
  assert.equal(again.tokenBudget.allowed, true);
  assert.equal(f.children.length, 1);
  assert.equal(f.calls.length, 0);
  // The A3 reading itself does not run again either.
  assert.equal((await f.service.autoAsr(saved.id)).id, saved.id);
  assert.equal(f.children.length, 1);
  // Another reading of the same bvid+cid, here an empty one.
  const empty = f.seed();
  assert.equal((await f.service.autoAsr(empty.id)).id, saved.id);
  assert.equal(f.children.length, 1);
});

test("a transcript that is no longer the longer text stays out of the view", async (t) => {
  const f = fixture(t);
  await f.service.autoAsr(f.seed().id);
  const fuller = f.seed(partial(100, "人工字幕".repeat(30)));
  const result = await f.service.autoAsr(fuller.id);
  assert.equal(result.id, fuller.id);
  assert.deepEqual(autoEntry(result), [
    { route: "A3", state: "auto_not_better" },
  ]);
  assert.equal(f.children.length, 1);
});

test("a hand-imported transcript counts: auto ASR reuses it instead of running", async (t) => {
  const f = fixture(t);
  const reading = f.seed(partial(100, "开"));
  const imported = (
    await f.service.importLocal(reading.id, {
      route: "A3",
      duration: 600,
      segments: [{ start: 0, end: 600, text: "人工导入的转写文字" }],
    })
  ).result;
  assert.equal((await f.service.autoAsr(reading.id)).id, imported.id);
  assert.equal(f.children.length, 0);
});

test("frames, chosen frames and danmaku stay reachable from the new reading ID", async (t) => {
  const f = fixture(t);
  const reading = f.seed();
  const sampled = (await f.service.visual(reading.id)).result;
  await f.service.visualAt(reading.id, [5]);
  f.service.store.setControl("danmaku:" + reading.id, {
    total: 1,
    rows: [[6, "弹幕", 0]],
  });
  const saved = await f.service.autoAsr(reading.id);
  assert.notEqual(saved.id, reading.id);
  assert.deepEqual(f.service.visualFrames(saved.id).frames, sampled.frames);
  assert.equal(
    f.service.framePage("visual-at:" + saved.id, saved.id).frameCount,
    1,
  );
  assert.deepEqual(f.service.danmakuAround(saved.id, 6), ["弹幕"]);
  // Frames taken after the transcript exists follow it on the next read.
  const later = fixture(t);
  const empty = later.seed();
  const transcript = await later.service.autoAsr(empty.id);
  await later.service.visual(empty.id);
  await later.service.autoAsr(empty.id);
  assert.equal(later.service.visualFrames(transcript.id).frameCount, 40);
  // What the new reading already holds is not overwritten.
  later.service.store.setControl("danmaku:" + transcript.id, {
    total: 1,
    rows: [[1, "新的", 0]],
  });
  later.service.store.setControl("danmaku:" + empty.id, {
    total: 1,
    rows: [[1, "旧的", 0]],
  });
  await later.service.autoAsr(empty.id);
  assert.deepEqual(later.service.danmakuAround(transcript.id, 1), ["新的"]);
});

test("cancellation before the task, during the download and during ASR propagates and is not remembered", async (t) => {
  const aborted = new AbortController();
  aborted.abort();
  const early = fixture(t);
  const earlyReading = early.seed();
  await assert.rejects(early.service.autoAsr(earlyReading.id, aborted.signal), {
    code: "CANCELLED",
  });
  assert.equal(early.calls.length + early.children.length, 0);

  const controller = new AbortController();
  const f = fixture(t, { scenario: "hold" });
  const reading = f.seed();
  const rejected = assert.rejects(
    f.service.autoAsr(reading.id, controller.signal),
    {
      code: "CANCELLED",
    },
  );
  for (let i = 0; i < 400 && !f.children.length; i += 1) await delay(10);
  assert.equal(f.children.length, 1);
  controller.abort();
  await rejected;
  f.clean();
  assert.equal(f.service.store.getControl(`auto-asr:${bv}:7`), null);
  assert.deepEqual(autoEntry(f.service.store.reading(reading.id)), []);
  f.state.scenario = "success";
  assert.equal((await f.service.autoAsr(reading.id)).route, "A3");

  const download = new AbortController();
  const g = fixture(t, {
    media: () => {
      download.abort();
      return new Response("SYNTHETIC_MEDIA");
    },
  });
  await assert.rejects(g.service.autoAsr(g.seed().id, download.signal), {
    code: "CANCELLED",
  });
  g.clean();
  assert.equal(g.children.length, 0);
});

test("a persistent pause propagates, before the task and from a platform risk response", async (t) => {
  const paused = fixture(t);
  const reading = paused.seed();
  paused.service.store.pause("SYNTHETIC_RISK");
  await assert.rejects(paused.service.autoAsr(reading.id), {
    code: "PERSISTENT_PAUSE",
  });
  assert.equal(paused.calls.length, 0);
  assert.deepEqual(autoEntry(paused.service.store.reading(reading.id)), []);

  const risky = fixture(t, {
    fetcher: () => new Response("", { status: 412 }),
  });
  await assert.rejects(risky.service.autoAsr(risky.seed().id), {
    code: "PLATFORM_PAUSED",
  });
  assert.equal(risky.service.store.status().pause.reason, "HTTP_412");
  risky.clean();
  assert.equal(risky.children.length, 0);

  const expired = fixture(t, {
    fetcher: () => json({ code: -101, message: "synthetic" }),
  });
  await assert.rejects(expired.service.autoAsr(expired.seed().id), {
    code: "CREDENTIAL_EXPIRED",
  });
  expired.clean();
});

test("only the DSH read tool reaches auto ASR", async (t) => {
  const source = (file) =>
    readFileSync(new URL("../" + file, import.meta.url), "utf8");
  for (const file of ["lib/daily-fetch.mjs", "bin/cli.mjs", "lib/reader.mjs"])
    assert.ok(!/autoAsr/.test(source(file)), file);
  const f = fixture(t, {
    fetcher: (path) => {
      if (path === "/x/web-interface/view")
        return json({
          code: 0,
          data: { pages: [{ page: 1, cid: 7, duration: 600 }] },
        });
      if (path === "/x/web-interface/nav") return json(wbiNav);
      if (path === "/x/player/wbi/v2")
        return json({ code: 0, data: { subtitle: { subtitles: [] } } });
      assert.fail("Unexpected synthetic request");
    },
  });
  const read = await f.service.read(bv);
  assert.equal(read.result.route, "none");
  assert.equal(f.children.length + f.doctors.length, 0);
  assert.deepEqual(autoEntry(read.result), []);
});

function readTool(t, config) {
  const root = mkdtempSync(join(tmpdir(), "humanism-auto-tool-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/x/web-interface/view")
      return json({
        code: 0,
        data: { pages: [{ page: 1, cid: 7, duration: 600 }] },
      });
    if (path === "/x/web-interface/nav") return json(wbiNav);
    if (path === "/x/player/wbi/v2")
      return json({ code: 0, data: { subtitle: { subtitles: [] } } });
    assert.fail("Unexpected synthetic request");
  };
  const tools = new Map();
  let dispose;
  apply(
    {
      tools: { register: (tool) => tools.set(tool.name, tool) },
      effect: (setup) => {
        dispose = setup();
      },
    },
    { dataDir: root, enableDailyFetching: false, ...config },
  );
  t.after(() => {
    dispose();
    globalThis.fetch = previousFetch;
  });
  return async () =>
    JSON.parse(
      await tools.get("bili_humanism_read").execute({ video: bv }, {}),
    );
}

test("the read tool reports the auto ASR outcome on its reading", async (t) => {
  const read = await readTool(t, { autoAsr: true })();
  assert.equal(read.error, undefined);
  assert.equal(read.result.route, "none");
  assert.deepEqual(autoEntry(read.result), [
    { route: "A3", state: "auto_unavailable", error: "ASR_MODEL_MISSING" },
  ]);
});

test("the read tool stays as it was while auto ASR is off", async (t) => {
  const read = await readTool(t, {})();
  assert.equal(read.result.route, "none");
  assert.deepEqual(autoEntry(read.result), []);
  assert.ok(read.result.attempts.some((a) => a.route === "A1"));
  assert.equal(read.result.tokenBudget.allowed, true);
});

test("frameContext joins what was said and viewer reactions around a moment, from cache only", async (t) => {
  const f = fixture(t, { config: { autoAsr: false } });
  const reading = f.seed({
    route: "A1",
    segments: [
      { start: 0, end: 5.9, text: "太早" },
      { start: 6, end: 8, text: "开始重叠" },
      { start: 9, end: null, text: "没有结束时间" },
      { start: 11, end: 12, text: "窗口内" },
      { start: 14, end: 15, text: "恰好到边界" },
      { start: 14.1, end: 15, text: "太晚" },
    ],
  });
  assert.deepEqual(f.service.frameContext(reading.id, 10), {
    said: "开始重叠 没有结束时间 窗口内 恰好到边界",
    danmaku: "",
  });
  f.service.store.setControl("danmaku:" + reading.id, {
    total: 4,
    rows: [
      [8, "同句", 0],
      [9, "同句", 0],
      [12, "另一句", 0],
      [30, "别处", 0],
    ],
  });
  assert.equal(
    f.service.frameContext(reading.id, 10).danmaku,
    "同句 ×2 / 另一句",
  );
  assert.deepEqual(f.service.frameContext(reading.id, 100), {
    said: "",
    danmaku: "",
  });
  assert.deepEqual(f.service.frameContext(f.seed().id, 10), {
    said: "",
    danmaku: "",
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.children.length, 0);
  assert.throws(() => f.service.frameContext("missing", 1), {
    code: "READING_NOT_FOUND",
  });
});

test("frameContext limits count characters, not UTF-16 units", (t) => {
  const f = fixture(t, { config: { autoAsr: false } });
  const reading = f.seed({
    route: "A1",
    segments: [{ start: 0, end: 10, text: "😀".repeat(150) }],
  });
  f.service.store.setControl("danmaku:" + reading.id, {
    total: 3,
    rows: [
      [5, "😀".repeat(50), 0],
      [5, "字".repeat(50) + "一", 0],
      [5, "字".repeat(50) + "二", 0],
    ],
  });
  const { said, danmaku } = f.service.frameContext(reading.id, 5);
  assert.equal(said, "😀".repeat(100));
  assert.equal([...danmaku].length, 80);
  assert.match(danmaku, / \/ /);
});

test("frameContext never cuts inside a count", (t) => {
  const f = fixture(t, { config: { autoAsr: false } });
  const rows = (n, text) => Array.from({ length: n }, () => [20, text, 0]);
  const reading = f.seed();
  f.service.store.setControl("danmaku:" + reading.id, {
    total: 12,
    rows: rows(12, "a".repeat(77)),
  });
  assert.equal(
    f.service.frameContext(reading.id, 20).danmaku,
    "a".repeat(75) + "… ×12",
  );
  f.service.store.setControl("danmaku:" + reading.id, {
    total: 135,
    rows: [...rows(123, "a".repeat(60)), ...rows(12, "b".repeat(20))],
  });
  assert.equal(
    f.service.frameContext(reading.id, 20).danmaku,
    "a".repeat(60) + " ×123 / " + "b".repeat(7) + "… ×12",
  );
});

test("a crashed ASR runs a bounded number of times, then stays explicit", async (t) => {
  const f = fixture(t, { scenario: "fail" });
  const reading = f.seed();
  const entry = {
    route: "A3",
    state: "auto_unavailable",
    error: "LOCAL_MEDIA_FAILED",
  };
  const key = `auto-asr:${bv}:7`;
  for (let run = 1; run <= 3; run += 1) {
    assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [entry]);
    assert.equal(f.children.length, run);
    assert.deepEqual(f.service.store.getControl(key), { ...entry, runs: run });
    f.clean();
  }
  f.state.scenario = "success";
  assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [entry]);
  assert.equal(f.children.length, 3);
  assert.equal(f.calls.length, 6);
  // A fix inside the bound helps, and what it saved replaces the count.
  const g = fixture(t, { scenario: "fail" });
  const fixed = g.seed();
  await g.service.autoAsr(fixed.id);
  g.state.scenario = "success";
  const saved = await g.service.autoAsr(fixed.id);
  assert.equal(saved.route, "A3");
  assert.equal(g.children.length, 2);
  assert.equal(g.service.store.getControl(key).state, "auto_saved");
});

test("a timeout stands until the wall budget is raised, and then runs again", async (t) => {
  const f = fixture(t, { scenario: "hold", config: { autoAsrWallMs: 2000 } });
  const reading = f.seed();
  const entry = {
    route: "A3",
    state: "auto_unavailable",
    error: "WALL_BUDGET",
  };
  assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [entry]);
  const key = `auto-asr:${bv}:7`;
  assert.deepEqual(f.service.store.getControl(key), { ...entry, wallMs: 2000 });
  f.clean();
  // A source that always times out costs its budget once, not on every read.
  assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [entry]);
  f.service.config.autoAsrWallMs = 1000;
  assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [entry]);
  assert.equal(f.children.length, 1);
  f.state.scenario = "success";
  f.service.config.autoAsrWallMs = 30000;
  const saved = await f.service.autoAsr(reading.id);
  assert.equal(saved.route, "A3");
  assert.equal(f.children.length, 2);
});

test("a failure that says nothing about the video is not remembered", async (t) => {
  const f = fixture(t);
  const reading = f.seed();
  const runMedia = f.service.runMedia;
  f.service.runMedia = async () => {
    throw new Fault("LOCAL_MEDIA_DEPENDENCY_FAILED");
  };
  assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [
    {
      route: "A3",
      state: "auto_unavailable",
      error: "LOCAL_MEDIA_DEPENDENCY_FAILED",
    },
  ]);
  assert.equal(f.service.store.getControl(`auto-asr:${bv}:7`), null);
  f.service.runMedia = runMedia;
  assert.equal((await f.service.autoAsr(reading.id)).route, "A3");
  // An entry from before this version says too little to stop a run.
  const g = fixture(t);
  const old = g.seed();
  g.service.store.setControl(`auto-asr:${bv}:7`, {
    route: "A3",
    state: "auto_unavailable",
    error: "INVALID_TIMESTAMP",
  });
  assert.equal((await g.service.autoAsr(old.id)).route, "A3");
});

test("malformed output is the video's own answer and is not repeated", async (t) => {
  for (const [scenario, error] of [
    ["garbled", "ASR_OUTPUT_INVALID"],
    ["no-output", "ASR_OUTPUT_INVALID"],
    ["not-a-list", "INVALID_SEGMENTS"],
    ["backwards", "INVALID_TIMESTAMP"],
  ]) {
    const f = fixture(t, { scenario });
    const reading = f.seed();
    const entry = { route: "A3", state: "auto_unavailable", error };
    assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [entry]);
    f.clean();
    assert.deepEqual(f.service.store.getControl(`auto-asr:${bv}:7`), {
      ...entry,
      malformed: true,
    });
    f.state.scenario = "success";
    assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [entry]);
    assert.equal(f.children.length, 1);
  }
});

test("a transcript over the token limit stands until that limit is raised", async (t) => {
  const f = fixture(t, { config: { maxReadTokens: 5 } });
  const reading = f.seed();
  const entry = {
    route: "A3",
    state: "auto_unavailable",
    error: "READ_TOKEN_BUDGET",
  };
  assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [entry]);
  assert.deepEqual(autoEntry(await f.service.autoAsr(reading.id)), [entry]);
  assert.equal(f.children.length, 1);
  f.service.config.maxReadTokens = 600000;
  assert.equal((await f.service.autoAsr(reading.id)).route, "A3");
  assert.equal(f.children.length, 2);
});

test("not better holds for readings with at least the heard text, and a shorter one runs again", async (t) => {
  const f = fixture(t, { scenario: "short" });
  const fuller = f.seed(partial(100, "已有的文字"));
  const key = `auto-asr:${bv}:7`;
  await f.service.autoAsr(fuller.id);
  assert.deepEqual(f.service.store.getControl(key), {
    route: "A3",
    state: "auto_not_better",
    heardCharacters: 1,
  });
  const equal = f.seed(partial(100, "同"));
  assert.deepEqual(autoEntry(await f.service.autoAsr(equal.id)), [
    { route: "A3", state: "auto_not_better" },
  ]);
  assert.equal(f.children.length, 1);
  // The track came back empty later: the verdict was not measured against this.
  const empty = f.seed();
  const saved = await f.service.autoAsr(empty.id);
  assert.equal(saved.route, "A3");
  assert.equal(saved.segments[0].text, "短");
  assert.deepEqual(autoEntry(saved), [{ route: "A3", state: "auto_saved" }]);
  assert.equal(f.children.length, 2);
  // A heard nothing stays not better for an empty reading, so that does not repeat.
  const g = fixture(t, { scenario: "empty" });
  const silent = g.seed();
  await g.service.autoAsr(silent.id);
  assert.deepEqual(autoEntry(await g.service.autoAsr(silent.id)), [
    { route: "A3", state: "auto_not_better" },
  ]);
  assert.equal(g.children.length, 1);
});

test("a failed ASR whose file could not be removed says so on the entry", async (t) => {
  const f = fixture(t, { scenario: "litter" });
  const reading = f.seed();
  const entry = {
    route: "A3",
    state: "auto_unavailable",
    error: "LOCAL_MEDIA_FAILED",
    mediaCleanup: "refused_or_failed",
  };
  const result = await f.service.autoAsr(reading.id);
  assert.deepEqual(autoEntry(result), [entry]);
  assert.deepEqual(autoEntry(f.service.store.reading(reading.id)), [entry]);
  assert.ok(existsSync(f.children[0][2] + ".extra"));
  assert.deepEqual(f.service.store.getControl(`auto-asr:${bv}:7`), {
    ...entry,
    runs: 1,
  });
  assert.deepEqual(
    JSON.parse(renderReadingText(result)[0].text).attempts.at(-1),
    "A3:auto_unavailable:LOCAL_MEDIA_FAILED:mediaCleanup=refused_or_failed",
  );
});
