import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Fault, need } from "./errors.mjs";

export const VISUAL_PAGE_SIZE = 4;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const samePath = (a, b) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
const within = (root, path) => {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(".." + sep)
  );
};
const stat = (path) => lstatSync(path, { bigint: true });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const frameDimensions = (width, height) =>
  positive(width) &&
  positive(height) &&
  Math.min(width, height) <= 480 &&
  Math.max(width, height) <= 1920 &&
  width * height <= 1920 * 480;

export async function visualCapability(ctx, exec) {
  const attachments = ctx.get?.("attachments");
  if (!attachments || typeof attachments.saveImages !== "function")
    throw new Fault(
      "VISUAL_ATTACHMENT_REQUIRED",
      "A durable DSH attachment service is required to deliver frame images.",
    );
  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  const llm = ctx.get?.("llm");
  if (provider === undefined || model === undefined || !llm?.resolveModelInfo)
    throw new Fault(
      "VISUAL_MODEL_ROUTE_UNAVAILABLE",
      "The current DSH model route could not be resolved; image reading is unavailable.",
    );
  const info = await llm.resolveModelInfo(provider, model, exec?.signal);
  if (!info?.inputModalities?.includes("image"))
    throw new Fault(
      "VISUAL_IMAGE_MODEL_REQUIRED",
      "The current DSH model does not declare image input; select an image-capable model to inspect frames.",
    );
  need(
    attachments.imageLimits?.mediaTypes?.includes("image/jpeg"),
    "VISUAL_JPEG_NOT_ACCEPTED",
  );
  return attachments;
}

export async function optionalVisualCapability(ctx, exec) {
  try {
    return { attachments: await visualCapability(ctx, exec) };
  } catch (error) {
    if (exec?.signal?.aborted) throw error;
    return {
      unavailable: {
        status: "unavailable",
        error:
          error instanceof Fault
            ? error.code
            : "VISUAL_MODEL_ROUTE_UNAVAILABLE",
        message:
          error instanceof Fault
            ? error.message
            : "The host image route could not be verified; text does not establish visual coverage.",
      },
    };
  }
}

function noLinks(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    need(!stat(current).isSymbolicLink(), "VISUAL_PATH_DENIED");
    if (dirname(current) === current) break;
  }
}

function jpegDimensions(data) {
  need(
    data.length >= 4 && data[0] === 255 && data[1] === 216,
    "VISUAL_FRAME_INVALID",
  );
  let cursor = 2;
  while (cursor < data.length) {
    need(data[cursor++] === 255, "VISUAL_FRAME_INVALID");
    while (data[cursor] === 255) cursor++;
    const marker = data[cursor++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    need(cursor + 2 <= data.length, "VISUAL_FRAME_INVALID");
    const length = data.readUInt16BE(cursor);
    need(length >= 2 && cursor + length <= data.length, "VISUAL_FRAME_INVALID");
    if (marker === 192 || marker === 194) {
      need(length >= 8 && data[cursor + 2] === 8, "VISUAL_FRAME_INVALID");
      const height = data.readUInt16BE(cursor + 3);
      const width = data.readUInt16BE(cursor + 5);
      need(frameDimensions(width, height), "VISUAL_FRAME_DIMENSIONS");
      return { width, height };
    }
    cursor += length;
  }
  throw new Fault("VISUAL_FRAME_INVALID");
}

function frameBytes(dataDir, visual, frame, byteCap) {
  const root = realpathSync(dataDir);
  const assets = join(root, "assets");
  const directory = resolve(visual.path);
  need(within(assets, directory), "VISUAL_PATH_DENIED");
  need(
    typeof frame.file === "string" &&
      basename(frame.file) === frame.file &&
      frame.file.length <= 100 &&
      /\.jpg$/i.test(frame.file),
    "VISUAL_PATH_DENIED",
  );
  const path = join(directory, frame.file);
  need(samePath(path, frame.path), "VISUAL_PATH_DENIED");
  noLinks(path);
  need(samePath(realpathSync(directory), directory), "VISUAL_PATH_DENIED");
  const directoryStat = stat(directory);
  need(directoryStat.isDirectory(), "VISUAL_PATH_DENIED");
  if (visual.directoryIdentity)
    need(
      String(directoryStat.dev) === visual.directoryIdentity.dev &&
        String(directoryStat.ino) === visual.directoryIdentity.ino,
      "VISUAL_FRAME_CHANGED",
    );
  need(
    positive(frame.bytes) &&
      frame.bytes <= byteCap &&
      /^[a-f0-9]{64}$/.test(frame.sha256),
    "VISUAL_FRAME_INVALID",
  );
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = fstatSync(fd, { bigint: true });
    need(
      before.isFile() &&
        before.nlink === 1n &&
        before.size === BigInt(frame.bytes),
      "VISUAL_FRAME_CHANGED",
    );
    if (typeof process.getuid === "function")
      need(before.uid === BigInt(process.getuid()), "VISUAL_PATH_DENIED");
    const buffer = Buffer.alloc(frame.bytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      length += read;
      if (!read || length === buffer.length) break;
    }
    const after = fstatSync(fd, { bigint: true });
    need(
      length === frame.bytes &&
        sameFile(before, after) &&
        after.nlink === 1n &&
        after.size === before.size,
      "VISUAL_FRAME_CHANGED",
    );
    const data = buffer.subarray(0, length);
    need(
      createHash("sha256").update(data).digest("hex") === frame.sha256,
      "VISUAL_FRAME_CHANGED",
    );
    const dimensions = jpegDimensions(data);
    return { data, dimensions };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function imageValue(ref) {
  need(
    ref && /^sha256:[a-f0-9]{64}$/.test(ref.attachmentId),
    "VISUAL_ATTACHMENT_INVALID",
  );
  need(
    ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
      ref.mediaType,
    ),
    "VISUAL_ATTACHMENT_INVALID",
  );
  need(
    positive(ref.bytes) &&
      ref.bytes <= MAX_FRAME_BYTES &&
      frameDimensions(ref.width, ref.height),
    "VISUAL_ATTACHMENT_INVALID",
  );
  const result = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  };
  if (typeof ref.name === "string" && ref.name.length <= 100)
    result.name = ref.name;
  if (ref.originalDimensions) {
    need(
      frameDimensions(
        ref.originalDimensions.width,
        ref.originalDimensions.height,
      ),
      "VISUAL_ATTACHMENT_INVALID",
    );
    result.originalDimensions = {
      width: ref.originalDimensions.width,
      height: ref.originalDimensions.height,
    };
  }
  return result;
}

export async function attachVisualPage(attachments, dataDir, visual, signal) {
  signal?.throwIfAborted();
  need(
    visual && typeof visual === "object" && Array.isArray(visual.frames),
    "VISUAL_PAGE_INVALID",
  );
  need(
    visual.source &&
      Number.isFinite(visual.source.duration) &&
      visual.source.duration > 0 &&
      visual.source.duration <= Number.MAX_SAFE_INTEGER &&
      typeof visual.readingId === "string",
    "VISUAL_PAGE_INVALID",
  );
  need(
    visual.frames.length > 0 &&
      visual.frames.length <= VISUAL_PAGE_SIZE &&
      Number.isSafeInteger(visual.frameOffset) &&
      visual.frameOffset >= 0 &&
      Number.isSafeInteger(visual.frameCount) &&
      visual.frameCount <= 40 &&
      visual.frameCount >= visual.frames.length,
    "VISUAL_PAGE_INVALID",
  );
  need(
    visual.nextOffset === null ||
      (Number.isSafeInteger(visual.nextOffset) &&
        visual.nextOffset > visual.frameOffset &&
        visual.nextOffset < visual.frameCount),
    "VISUAL_PAGE_INVALID",
  );
  need(
    visual.frameOffset + visual.frames.length <= visual.frameCount &&
      visual.nextOffset ===
        (visual.frameOffset + visual.frames.length < visual.frameCount
          ? visual.frameOffset + visual.frames.length
          : null),
    "VISUAL_PAGE_INVALID",
  );
  const limits = attachments.imageLimits;
  const byteCap = Math.min(
    MAX_FRAME_BYTES,
    limits.maxImageBytes,
    limits.maxMessageImageBytes,
  );
  const pageCap = Math.min(MAX_PAGE_BYTES, limits.maxMessageImageBytes);
  need(
    positive(byteCap) &&
      positive(pageCap) &&
      positive(limits.maxImagesPerMessage) &&
      visual.frames.length <= limits.maxImagesPerMessage,
    "VISUAL_ATTACHMENT_LIMIT",
  );
  let total = 0;
  const frames = visual.frames.map((frame) => {
    need(
      Number.isFinite(frame.at) &&
        frame.at >= 0 &&
        frame.at <= visual.source.duration,
      "VISUAL_PAGE_INVALID",
    );
    const checked = frameBytes(dataDir, visual, frame, byteCap);
    total += checked.data.length;
    need(
      total <= pageCap &&
        checked.dimensions.width <= limits.maxImageDimension &&
        checked.dimensions.height <= limits.maxImageDimension &&
        checked.dimensions.width * checked.dimensions.height <=
          limits.maxImagePixels,
      "VISUAL_ATTACHMENT_LIMIT",
    );
    return { ...checked, at: frame.at, file: frame.file };
  });
  signal?.throwIfAborted();
  const refs = await attachments.saveImages(
    frames.map((frame) => ({
      data: frame.data,
      mediaType: "image/jpeg",
      name: frame.file,
    })),
  );
  signal?.throwIfAborted();
  need(
    Array.isArray(refs) && refs.length === frames.length,
    "VISUAL_ATTACHMENT_INVALID",
  );
  const images = refs.map((ref, index) => ({
    at: frames[index].at,
    image: imageValue(ref),
  }));
  need(
    images.reduce((sum, frame) => sum + frame.image.bytes, 0) <= pageCap &&
      images.every(
        ({ image }) =>
          image.bytes <= byteCap &&
          image.width <= limits.maxImageDimension &&
          image.height <= limits.maxImageDimension &&
          image.width * image.height <= limits.maxImagePixels,
      ),
    "VISUAL_ATTACHMENT_LIMIT",
  );
  return {
    status: "frames_ready",
    readingId: visual.readingId,
    source: {
      bvid: String(visual.source.bvid),
      page: visual.source.page,
      cid: String(visual.source.cid),
      duration: visual.source.duration,
    },
    frameOffset: visual.frameOffset,
    frameCount: visual.frameCount,
    nextOffset: visual.nextOffset,
    coverage: visual.coverage,
    intermediateVideo: visual.intermediateVideo,
    images,
    note: "These are sampled source images, not an OCR transcript or proof of complete viewing. Read the attached images before making visual claims; preserve timestamps and uncertainty.",
  };
}

const imageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    attachmentId: { type: "string", required: true },
    mediaType: { type: "string", required: true },
    bytes: { type: "integer", required: true },
    width: { type: "integer", required: true },
    height: { type: "integer", required: true },
    name: { type: "string" },
    originalDimensions: { type: "json" },
  },
};
export const VISUAL_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        error: { type: "string", required: true },
        message: { type: "string", required: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["frames_ready"], required: true },
        readingId: { type: "string", required: true },
        source: { type: "json", required: true },
        frameOffset: { type: "integer", required: true },
        frameCount: { type: "integer", required: true },
        nextOffset: { type: "json", required: true },
        coverage: { type: "json", required: true },
        intermediateVideo: { type: "string", required: true },
        note: { type: "string", required: true },
        images: {
          type: "array",
          required: true,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              at: { type: "number", required: true },
              image: { ...imageSchema, required: true },
            },
          },
        },
      },
    },
  ],
};

export function visualImageBlocks(value) {
  if (value?.status !== "frames_ready" || !Array.isArray(value.images))
    return [];
  need(value.images.length <= VISUAL_PAGE_SIZE, "VISUAL_PAGE_INVALID");
  return value.images.flatMap((frame) => [
    {
      type: "text",
      text: `Sampled frame at ${frame.at} seconds; visual coverage remains partial.`,
    },
    { type: "image", attachment: imageValue(frame.image) },
  ]);
}

export function renderVisualOutput(_args, value) {
  return [
    { type: "text", text: JSON.stringify(value, null, 2) },
    ...visualImageBlocks(value),
  ];
}

export function renderReadOutput(_args, value) {
  const parsed = JSON.parse(value);
  return [{ type: "text", text: value }, ...visualImageBlocks(parsed.visual)];
}
