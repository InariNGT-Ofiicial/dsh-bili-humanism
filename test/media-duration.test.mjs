import { wbiNav } from "./fixtures/wbi.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Service } from "../lib/service.mjs";
import { Config, apply } from "../index.js";

const worker = `
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [kind,...args]=process.argv.slice(2);
if(kind==='doctor'){console.log(JSON.stringify({status:'ready'}));process.exit(0);}
const [mode,input,output]=args;
const duration=Number(args[args.indexOf('--duration')+1]);
if(mode==='asr')writeFileSync(output,JSON.stringify({route:'A3',duration,segments:[{start:0,end:duration,text:'Synthetic ASR'}]}));
else {mkdirSync(output,{recursive:true});const frames=[0,duration/2,duration-1].map((at,i)=>{const file='frame-00'+i+'-'+at.toFixed(2)+'.jpg';writeFileSync(join(output,file),Buffer.from([255,216,255,217]));return {at,file,width:160,height:96};});writeFileSync(join(output,'manifest.json'),JSON.stringify({route:'frame',duration,sampling:'synthetic',frames}));}
`;
const json = (body) => new Response(JSON.stringify(body));

function fixture(t, duration = 927, config = {}) {
  const root = mkdtempSync(join(tmpdir(), "humanism-duration-"));
  const script = join(root, "worker.mjs");
  writeFileSync(script, worker);
  const children = [];
  const service = new Service(
    { dataDir: join(root, "private"), ...config },
    {
      fetcher: async (url) => {
        const path = new URL(url).pathname;
        if (path === "/x/web-interface/view")
          return json({
            code: 0,
            data: {
              title: "Synthetic long source",
              owner: { mid: 1 },
              pages: [{ page: 1, cid: 7, duration }],
            },
          });
        if (path === "/x/web-interface/nav") return json(wbiNav);
        if (path === "/x/player/wbi/v2")
          return json({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  { subtitle_url: "https://aisubtitle.hdslb.com/source.json" },
                ],
              },
            },
          });
        if (path === "/source.json")
          return json({
            body: [
              { from: 0, to: duration, content: "Synthetic long transcript" },
            ],
          });
        if (path === "/x/player/playurl")
          return json({
            code: 0,
            data: {
              quality: 32,
              dash: {
                video: [
                  {
                    id: 32,
                    width: 160,
                    height: 96,
                    bandwidth: 1000,
                    baseUrl: "https://synthetic.bilivideo.com/media.mp4",
                  },
                ],
                audio: [
                  {
                    bandwidth: 1000,
                    baseUrl: "https://synthetic.bilivideo.com/media.mp4",
                  },
                ],
              },
            },
          });
        if (path === "/media.mp4") return new Response("SYNTHETIC_MEDIA");
        assert.fail("Unexpected synthetic request");
      },
      spawn: (_executable, argv, settings) => {
        const doctor = ["frame_environment.py", "asr_environment.py"].includes(
          basename(argv[0]),
        );
        if (!doctor) children.push(argv);
        return spawn(
          process.execPath,
          [script, doctor ? "doctor" : "media", ...argv.slice(1)],
          settings,
        );
      },
    },
  );
  t.after(() => service.close());
  return { root, service, children };
}

test("media has no fixed default duration gate, including sources beyond six hours", async (t) => {
  for (const duration of [927, 25000])
    await t.test(String(duration), async (t) => {
      const f = fixture(t, duration);
      const read = await f.service.readVisual("BV0000000001");
      assert.equal(read.result.route, "A1");
      assert.equal(read.result.visual.status, "sampled_frames");
      assert.equal(read.result.visual.source.duration, duration);
      assert.equal(read.result.visual.frameCount, 3);
      assert.equal(read.result.visual.frames.at(-1).at, duration - 1);
      assert.equal(f.service.status().media.maxSourceSeconds, null);
      const argv = f.children[0];
      assert.ok(!argv.includes("--max-seconds"));
      assert.equal(
        Number(argv[argv.indexOf("--interval") + 1]),
        Math.max(15, duration / 39),
      );
      assert.deepEqual(
        readdirSync(join(f.service.store.root, "media-intermediates")),
        [],
      );
      assert.equal(existsSync(argv[2]), false);
      assert.equal(read.usage.requests, 6);
      assert.equal(f.service.limits.wallMs, 90000);
      assert.equal(f.service.limits.requests, 12);
    });
});

test("audio, local ASR and local frames pass long sources without an implicit Python cap", async (t) => {
  const f = fixture(t);
  const read = await f.service.read("BV0000000001");
  const audio = await f.service.audio(read.result.id);
  assert.equal(audio.result.duration, 927);
  const asr = await f.service.localMedia(
    "asr",
    read.result.id,
    audio.result.path,
    f.root,
  );
  assert.equal(asr.result.route, "A3");
  assert.equal(asr.result.segments[0].end, 927);
  const frames = await f.service.localMedia(
    "frames",
    read.result.id,
    audio.result.path,
  );
  assert.equal(frames.result.status, "sampled_frames");
  for (const argv of f.children) assert.ok(!argv.includes("--max-seconds"));
  assert.ok(f.children[1].includes("--strict-duration"));
});

test("explicit human limits remain effective while text stays readable", async (t) => {
  for (const config of [
    { maxMediaSeconds: 600 },
    { limits: { asrSeconds: 600 } },
    { maxMediaSeconds: 1200, limits: { asrSeconds: 600 } },
  ])
    await t.test(JSON.stringify(config), async (t) => {
      const f = fixture(t, 927, config);
      const read = await f.service.readVisual("BV0000000001");
      assert.equal(read.result.route, "A1");
      assert.equal(read.result.visual.error, "MEDIA_DURATION_BUDGET");
      assert.equal(f.children.length, 0);
      assert.equal(f.service.status().media.maxSourceSeconds, 600);
      await assert.rejects(
        f.service.audio(read.result.id),
        (e) => e.code === "ASR_BUDGET",
      );
      await assert.rejects(
        f.service.localMedia("asr", read.result.id, "unused"),
        (e) => e.code === "ASR_BUDGET",
      );
    });
  const f = fixture(t, 927, { maxMediaSeconds: 1200 });
  const read = await f.service.readVisual("BV0000000001");
  assert.equal(read.result.visual.status, "sampled_frames");
  assert.equal(
    f.children[0][f.children[0].indexOf("--max-seconds") + 1],
    "1200",
  );
});

test("host config and CLI preserve optional human limits, never model overrides", async () => {
  assert.equal(Config({}).maxMediaSeconds, undefined);
  assert.equal(Config({ maxMediaSeconds: null }).maxMediaSeconds, null);
  for (const n of [1, 1200, Number.MAX_SAFE_INTEGER])
    assert.equal(Config({ maxMediaSeconds: n }).maxMediaSeconds, n);
  for (const n of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    "1200",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => Config({ maxMediaSeconds: n }));
    assert.throws(
      () => new Service({ maxMediaSeconds: n }),
      (e) => e.code === "INVALID_MEDIA_SECONDS",
    );
  }
  const root = mkdtempSync(join(tmpdir(), "humanism-duration-cli-"));
  const tools = new Map();
  let dispose;
  apply(
    {
      tools: {
        register(t) {
          tools.set(t.name, t);
        },
      },
      effect(setup) {
        dispose = setup();
      },
    },
    { dataDir: join(root, "host"), enableDailyFetching: false },
  );
  try {
    const error = JSON.parse(
      await tools
        .get("bili_humanism_read")
        .execute({ video: "BV0000000001", maxMediaSeconds: 1200 }, {}),
    );
    assert.equal(error.error, "UNKNOWN_PARAMETER");
    for (const tool of tools.values())
      assert.equal(Object.hasOwn(tool.parameters, "maxMediaSeconds"), false);
  } finally {
    dispose();
  }
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ dataDir: join(root, "cli"), maxMediaSeconds: 1200 }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("BILI_HUMANISM_"),
    ),
  );
  const result = spawnSync(process.execPath, ["bin/cli.mjs", "status"], {
    cwd: new URL("..", import.meta.url),
    env: { ...env, BILI_HUMANISM_CONFIG_FILE: config },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).media.maxSourceSeconds, 1200);
  assert.deepEqual(JSON.parse(result.stdout).platformWriteTools, []);
});

test("optional Python adapter preserves long-source and precision boundaries", (t) => {
  const available = spawnSync("python", ["--version"], { encoding: "utf8" });
  if (available.status !== 0)
    return t.skip("Optional Python interpreter unavailable");
  const result = spawnSync("python", ["test/media-duration.test.py"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
