import { Fault, need } from "./errors.mjs";

export const DANMAKU_ITEM_LIMIT = 6000;
const TEXT_LIMIT = 80;
const LINE_LIMIT = 40;
const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// Each part stops at the next "<" or ">", so a hostile 16 MiB document scans in
// linear time. Bilibili escapes "<" inside text; anything else is not a <d> item.
const element = /<d\s([^<>]*)>([^<]*)<\/d\s*>/g;
const attribute = /(?:^|\s)p\s*=\s*(?:"([^"]*)"|'([^']*)')/;

// One pass, so "&amp;lt;" stays the literal text "&lt;". References that name
// no Unicode scalar value decode to nothing rather than throwing.
function decodeEntities(raw) {
  return raw.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (_, decimal, hex, name) => {
      if (name) return named[name];
      const point = decimal ? Number(decimal) : parseInt(hex, 16);
      return point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
        ? String.fromCodePoint(point)
        : "";
    },
  );
}
// Control whitespace still separates words; other control characters vanish.
const clean = (raw) =>
  decodeEntities(raw)
    .replace(/\p{Cc}/gu, (c) => (/\s/.test(c) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
// Characters are code points. Two UTF-16 units per point at most, so a longer
// string is over the limit without spreading it.
const overLimit = (value, limit) =>
  value.length > limit * 2 || [...value].length > limit;

/** Also reports how many <d> elements the document held before any filtering. */
export function scanDanmakuXml(xml, duration) {
  if (typeof xml !== "string") throw new Fault("DANMAKU_INVALID");
  need(Number.isFinite(duration) && duration > 0, "INVALID_DURATION");
  let total = 0;
  const items = [];
  for (const [, attributes, raw] of xml.matchAll(element)) {
    total += 1;
    const match = attribute.exec(attributes);
    if (!match) continue;
    const parts = (match[1] ?? match[2]).split(",");
    if (!/^\d+(?:\.\d+)?$/.test(parts[0])) continue;
    const t = Number(parts[0]);
    if (t > duration + 1) continue;
    if (!/^[1-6]$/.test(parts[1] ?? "") || Number(parts[5]) === 2) continue;
    const text = clean(raw);
    if (!text || overLimit(text, TEXT_LIMIT)) continue;
    const weight = Number(parts[8]);
    items.push({
      t,
      text,
      weight: Number.isFinite(weight) ? weight : 0,
      id: parts[7] ?? "",
    });
  }
  if (items.length > DANMAKU_ITEM_LIMIT) {
    items.sort((a, b) => b.weight - a.weight);
    items.length = DANMAKU_ITEM_LIMIT;
  }
  items.sort((a, b) => a.t - b.t);
  return { total, items };
}
export function parseDanmakuXml(xml, duration) {
  return scanDanmakuXml(xml, duration).items;
}
function tally(items, from, to) {
  const groups = new Map();
  for (const { t, text, weight } of items) {
    if (!(t >= from && t <= to)) continue;
    const group = groups.get(text);
    if (group) {
      group.n += 1;
      group.weight = Math.max(group.weight, weight);
    } else groups.set(text, { text, n: 1, weight });
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.n - a.n ||
      b.weight - a.weight ||
      (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
  );
}
const suffix = (n) => (n > 1 ? ` ×${n}` : "");
// " ×12" and " / " are ours: a count we computed and the gap between two entries. One
// viewer's text must not read as either, so it gets look-alikes of the same width. The
// stored text and the groups stay as they were.
const quoted = (text) =>
  text.replace(/(^|\s)×(?=\d)/g, "$1x").replace(/(^|\s)\/(?=\s|$)/g, "$1／");
export function summarize(items, from, to, top = 16) {
  return tally(items, from, to)
    .slice(0, top)
    .map(({ text, n }) => quoted(text) + suffix(n));
}
/**
 * Joins entries within a limit in characters. What fits stays whole; the first that does
 * not loses text, never its count, or goes when not even that fits. Nothing follows it.
 */
export function fitEntries(entries, limit, gap = " / ") {
  const kept = [];
  let left = limit;
  for (const entry of entries) {
    const room = left - (kept.length ? gap.length : 0);
    const size = [...entry].length;
    if (size <= room) {
      kept.push(entry);
      left = room - size;
      continue;
    }
    const count = / ×\d+$/.exec(entry)?.[0] ?? "";
    const text = entry.slice(0, entry.length - count.length);
    if (room > count.length + 1)
      kept.push(
        [...text].slice(0, room - count.length - 1).join("") + "…" + count,
      );
    break;
  }
  return kept.join(gap);
}
// Shortens the text, never the count: the whole entry stays within LINE_LIMIT.
function peakLine({ text: raw, n }) {
  const text = quoted(raw);
  const tail = suffix(n);
  if (!overLimit(text, LINE_LIMIT - tail.length)) return text + tail;
  return [...text].slice(0, LINE_LIMIT - tail.length - 1).join("") + "…" + tail;
}
function median(sorted) {
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function peaks(
  items,
  duration,
  { binSeconds = 10, count = 6, minGap = 30, lines = 8 } = {},
) {
  need(
    Number.isFinite(duration) &&
      duration > 0 &&
      Number.isFinite(binSeconds) &&
      binSeconds > 0,
    "INVALID_DURATION",
  );
  // The tail second allowed past the duration belongs to the final bin.
  const lastBin = Math.max(0, Math.ceil(duration / binSeconds) - 1);
  const bins = new Map();
  for (const item of items) {
    if (!(item.t >= 0 && item.t <= duration + 1)) continue;
    const index = Math.min(lastBin, Math.floor(item.t / binSeconds));
    if (bins.has(index)) bins.get(index).push(item);
    else bins.set(index, [item]);
  }
  if (!bins.size) return [];
  const sizes = [...bins.values()].map((bin) => bin.length);
  const threshold = Math.max(3, 2 * median(sizes.sort((a, b) => a - b)));
  const chosen = [];
  for (const [, bin] of [...bins]
    .filter(([, bin]) => bin.length >= threshold)
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])) {
    if (chosen.length >= count) break;
    const mean = bin.reduce((sum, item) => sum + item.t, 0) / bin.length;
    const at = Math.min(duration, Math.round(mean * 10) / 10);
    // Measured on the reported times, so callers see the promised spacing.
    if (chosen.some((peak) => Math.abs(peak.at - at) < minGap)) continue;
    chosen.push({
      at,
      n: bin.length,
      // The bin's own items: an inclusive time window would also take the first
      // item of the next bin.
      lines: tally(bin, -Infinity, Infinity).slice(0, lines).map(peakLine),
    });
  }
  return chosen.sort((a, b) => a.at - b.at);
}
