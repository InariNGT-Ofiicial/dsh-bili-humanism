import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Fault, need } from "./errors.mjs";
import { RESPONSE_BYTE_LIMITS } from "./network.mjs";

const stat = (path) => lstatSync(path, { bigint: true });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
export const inside = (root, path) => {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))
  );
};
export function noLinks(path) {
  for (let current = path; ; current = dirname(current)) {
    need(!stat(current).isSymbolicLink(), "VISUAL_PATH_DENIED");
    if (dirname(current) === current) break;
  }
}

// Own a newly created, exclusive file before any network request. No user file is adopted.
export function temporaryVideo(dataDir) {
  const root = realpathSync(dataDir),
    parent = join(root, "media-intermediates");
  try {
    mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  noLinks(parent);
  const parentStat = stat(parent);
  need(
    parentStat.isDirectory() && realpathSync(parent) === parent,
    "VISUAL_PATH_DENIED",
  );
  const directory = mkdtempSync(join(parent, "video-")),
    directoryStat = stat(directory);
  const path = join(directory, "video.mp4");
  let handle, owned;
  try {
    handle = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    owned = fstatSync(handle, { bigint: true });
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    try {
      rmdirSync(directory);
    } catch {
      /* Only remove an empty task directory. */
    }
    throw error;
  }
  return {
    path,
    write(bytes) {
      need(handle !== null, "VISUAL_INPUT_CLOSED");
      writeFileSync(handle, bytes);
      closeSync(handle);
      handle = null;
    },
    cleanup() {
      if (handle !== null) {
        closeSync(handle);
        handle = null;
      }
      noLinks(parent);
      for (const [entry, expected] of [
        [parent, parentStat],
        [directory, directoryStat],
      ]) {
        const current = stat(entry);
        need(
          current.isDirectory() &&
            !current.isSymbolicLink() &&
            same(current, expected),
          "VISUAL_CLEANUP_REFUSED",
        );
      }
      need(
        inside(root, path) && realpathSync(directory) === directory,
        "VISUAL_CLEANUP_REFUSED",
      );
      let current;
      try {
        current = stat(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (current) {
        need(
          current.isFile() &&
            !current.isSymbolicLink() &&
            current.nlink === 1n &&
            same(current, owned),
          "VISUAL_CLEANUP_REFUSED",
        );
        unlinkSync(path);
      }
      rmdirSync(directory); // Empty task directory only. Never scan or recursively delete assets.
    },
  };
}

const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
function alternatives(primary, tracks) {
  const urls = new Set([primary]);
  for (const track of tracks) {
    for (const value of [
      track.baseUrl || track.base_url || track.url,
      ...(Array.isArray(track.backupUrl) ? track.backupUrl : []),
      ...(Array.isArray(track.backup_url) ? track.backup_url : []),
    ]) {
      if (typeof value === "string" && value && urls.size < 6) urls.add(value);
    }
    if (urls.size === 6) break;
  }
  return [...urls].slice(1);
}
export function audioTrack(data) {
  const tracks = data?.dash?.audio;
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const eligible = tracks.filter(
    (track) =>
      Number.isFinite(track.bandwidth) &&
      track.bandwidth > 0 &&
      typeof (track.baseUrl || track.base_url) === "string",
  );
  if (!eligible.length) return null;
  eligible.sort((a, b) => a.bandwidth - b.bandwidth);
  const selected = eligible[0];
  const url = selected.baseUrl || selected.base_url;
  return {
    url,
    alternatives: alternatives(
      url,
      eligible.filter((track) => track.bandwidth === selected.bandwidth),
    ),
  };
}
export async function firstMediaBytes(network, budget, urls) {
  for (let position = 0; position < urls.length; position += 1) {
    try {
      return await network.get(urls[position], "media");
    } catch (error) {
      if (
        !(error instanceof Fault) ||
        ![
          "URL_DENIED",
          "NETWORK_FAILED",
          "HTTP_FAILED",
          "BODY_READ_FAILED",
        ].includes(error.code) ||
        position + 1 === urls.length
      )
        throw error;
      budget.check();
    }
  }
  throw new Fault("NETWORK_FAILED");
}
// Leaves room for container overhead and for bitrate estimates running low.
const VIDEO_BYTE_TARGET = RESPONSE_BYTE_LIMITS.media * 0.9;
// Known duration: the largest short side expected to fit the media cap, else the
// lowest bitrate. Alternatives come from the same pool, so a fallback address
// cannot be a variant that was just ruled out as too large.
function videoCandidates(eligible, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return eligible;
  const fitting = eligible.filter(
    (track) => (track.bandwidth * duration) / 8 <= VIDEO_BYTE_TARGET,
  );
  if (fitting.length) return fitting;
  const lowest = eligible.reduce(
    (low, track) => Math.min(low, track.bandwidth),
    Infinity,
  );
  return eligible.filter((track) => track.bandwidth === lowest);
}
export function videoTrack(data, duration) {
  const tracks = data?.dash?.video;
  if (Array.isArray(tracks) && tracks.length) {
    const eligible = tracks.filter(
      (track) =>
        integer(track.id, 1, 32) &&
        integer(track.height, 1, 1920) &&
        integer(track.width, 1, 1920) &&
        Math.min(track.width, track.height) <= 480 &&
        track.width * track.height <= 480 * 1920 &&
        integer(track.bandwidth, 1, 20000000) &&
        typeof (track.baseUrl || track.base_url) === "string",
    );
    eligible.sort(
      (a, b) =>
        Math.min(b.width, b.height) - Math.min(a.width, a.height) ||
        a.bandwidth - b.bandwidth,
    );
    need(eligible.length > 0, "VIDEO_480P_UNAVAILABLE");
    const pool = videoCandidates(eligible, duration);
    const selected = pool[0];
    const url = selected.baseUrl || selected.base_url;
    return {
      url,
      alternatives: alternatives(
        url,
        pool.filter(
          (track) =>
            track.id === selected.id &&
            track.width === selected.width &&
            track.height === selected.height,
        ),
      ),
      transport: "dash",
      quality: selected.id,
      width: selected.width,
      height: selected.height,
      bandwidth: selected.bandwidth,
    };
  }
  need(
    integer(data?.quality, 1, 32) &&
      Array.isArray(data?.durl) &&
      data.durl.length === 1,
    "VIDEO_480P_UNAVAILABLE",
  );
  const entry = data.durl[0];
  need(
    typeof entry.url === "string" &&
      integer(entry.size, 1, 32 * 1024 * 1024) &&
      Number.isFinite(entry.length) &&
      entry.length > 0,
    "VIDEO_480P_UNAVAILABLE",
  );
  return {
    url: entry.url,
    alternatives: alternatives(entry.url, [entry]),
    transport: "durl",
    quality: data.quality,
  };
}

// On Windows a killed process can hold its input a moment longer: a venv python.exe is a
// launcher, and the interpreter behind it outlives the close event. Only that waits; a
// refusal is an answer.
const CLEANUP_WAIT_MS = 2000;
const CLEANUP_RETRY_MS = 50;
export async function cleanupVideo(owned, error, waitMs = CLEANUP_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      owned.cleanup();
      return;
    } catch (cause) {
      if (["EBUSY", "EPERM"].includes(cause.code) && Date.now() < deadline) {
        await delay(CLEANUP_RETRY_MS);
        continue;
      }
      if (!error) throw new Fault("VISUAL_CLEANUP_FAILED");
      error.mediaCleanup = "refused_or_failed";
      return;
    }
  }
}

// Keep a strict allocation/read limit even if a local file changes after a path stat.
export function boundedFrameBytes(path, expected = null) {
  const cap = 2 * 1024 * 1024;
  const before = stat(path);
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(cap),
    "VISUAL_PATH_DENIED",
  );
  const handle = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fstatSync(handle, { bigint: true });
    need(
      opened.isFile() &&
        opened.nlink === 1n &&
        same(before, opened) &&
        opened.size === before.size,
      "VISUAL_IMAGE_CHANGED",
    );
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(
        handle,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!count) break;
      length += count;
    }
    need(length === Number(opened.size), "VISUAL_IMAGE_CHANGED");
    const result = bytes.subarray(0, length);
    if (expected)
      need(
        length === expected.bytes &&
          createHash("sha256").update(result).digest("hex") === expected.sha256,
        "VISUAL_IMAGE_CHANGED",
      );
    return result;
  } finally {
    closeSync(handle);
  }
}
