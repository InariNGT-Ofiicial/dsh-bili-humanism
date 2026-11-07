import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { segments } from "../lib/reader.mjs";
import { Service } from "../lib/service.mjs";
import { safeError } from "../lib/errors.mjs";
import { wbiNav } from "./fixtures/wbi.mjs";

function diagnostics(rows, duration = 104, route = "A1") {
  try {
    segments(rows, duration, route);
    assert.fail("Invalid track accepted");
  } catch (error) {
    assert.equal(error.code, "INVALID_TIMESTAMP");
    return JSON.parse(
      safeError(error).message.slice("INVALID_TIMESTAMP ".length),
    );
  }
}

test("timestamp failure reports original input index and bounded track timing, without saving partial text", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "humanism-timestamps-")),
    calls = [];
  const rows = [
    { from: 1, to: 2, content: " " },
    { from: 0, to: 3.4, content: "SYNTHETIC_PRIVATE_TEXT" },
    { from: 268.24, to: 270.4, content: "SYNTHETIC_PRIVATE_TEXT" },
  ];
  const service = new Service(
    { dataDir: root },
    {
      fetcher: async (raw) => {
        const path = new URL(raw).pathname;
        calls.push(path);
        const data =
          path === "/x/web-interface/view"
            ? {
                code: 0,
                data: {
                  pages: [{ page: 1, cid: 7, duration: 104 }],
                  owner: { mid: 1 },
                },
              }
            : path === "/x/web-interface/nav"
              ? wbiNav
              : path === "/x/player/wbi/v2"
                ? {
                    code: 0,
                    data: {
                      subtitle: {
                        subtitles: [
                          {
                            lan: "ai-zh",
                            subtitle_url:
                              "https://aisubtitle.hdslb.com/synthetic.json",
                          },
                        ],
                      },
                    },
                  }
                : path === "/synthetic.json"
                  ? { body: rows }
                  : assert.fail("Unexpected endpoint");
        return new Response(JSON.stringify(data));
      },
    },
  );
  t.after(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(service.read("BV0000000001"), (error) => {
    const value = JSON.parse(
      safeError(error).message.slice("INVALID_TIMESTAMP ".length),
    );
    assert.equal(value.segment_index, 2);
    assert.equal(value.input_rows, 3);
    assert.equal(value.text_rows, 2);
    assert.equal(value.start, 268.24);
    assert.equal(value.end, 270.4);
    assert.equal(value.duration_seconds, 104);
    assert.equal(value.route, "A1");
    assert.equal(value.min_start_seconds, 0);
    assert.equal(value.max_start_seconds, 268.24);
    assert.equal(value.max_end_seconds, 270.4);
    assert.equal(value.reason, "start_after_source");
    assert.ok(!error.message.includes("SYNTHETIC_PRIVATE_TEXT"));
    assert.ok(error.message.length < 1000);
    return true;
  });
  assert.equal(calls.length, 4);
  assert.equal(
    service.store.db.prepare("SELECT count(*) n FROM cache").get().n,
    0,
  );
});

test("reversed numeric-string times stay rejected and report normalized numeric values", () => {
  const value = diagnostics([{ start: "3", end: "2", text: "Synthetic" }]);
  assert.equal(value.reason, "end_before_start");
  assert.equal(value.start, 3);
  assert.equal(value.end, 2);
});

test("nonnumeric timing values and unknown route text are withheld", () => {
  const secret = "SYNTHETIC_SECRET/file?token=private";
  const value = diagnostics(
    [{ start: secret, end: "not-a-time", text: secret }],
    60,
    secret,
  );
  assert.equal(value.reason, "start_not_finite");
  assert.equal(value.start, "non_finite");
  assert.equal(value.end, "non_finite");
  assert.equal(value.route, "unknown");
  assert.ok(!JSON.stringify(value).includes(secret));
});

test("diagnostics retain strict end, negative-start and import-route checks", () => {
  for (const route of ["A2", "A3", "frame"]) {
    for (const [start, end, reason] of [
      [-1, 2, "start_negative"],
      [0, 110, "end_after_source"],
      [0, Infinity, "end_not_finite"],
    ]) {
      const value = diagnostics(
        [{ start, end, text: "Synthetic" }],
        104,
        route,
      );
      assert.equal(value.route, route);
      assert.equal(value.reason, reason);
    }
  }
});

test("successful segments keep the existing shape, empty-text filtering and order", () => {
  assert.deepEqual(
    segments(
      [
        { from: 4, to: 5, content: "B" },
        { from: "invalid", to: "invalid", content: " " },
        { from: 1, to: null, content: "A" },
      ],
      6,
    ),
    [
      { start: 1, end: null, text: "A", source: "A1" },
      { start: 4, end: 5, text: "B", source: "A1" },
    ],
  );
});
