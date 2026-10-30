import { createHash } from "node:crypto";
import { need } from "./errors.mjs";

const mixinTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

// These URLs provide public signing material only; they are never fetched.
export function wbiKey(images) {
  try {
    const stem = (raw) => {
      const u = new URL(raw);
      need(
        u.protocol === "https:" && !u.username && !u.password,
        "WBI_UNAVAILABLE",
      );
      const value = u.pathname.split("/").at(-1).split(".")[0];
      need(/^[a-f0-9]{32}$/.test(value), "WBI_UNAVAILABLE");
      return value;
    };
    const raw = stem(images?.img_url) + stem(images?.sub_url);
    return mixinTab
      .map((i) => raw[i])
      .join("")
      .slice(0, 32);
  } catch {
    return null;
  }
}

export function sign(
  params,
  img,
  sub,
  timestamp = Math.floor(Date.now() / 1000),
) {
  const mix = wbiKey({ img_url: img, sub_url: sub });
  need(mix, "WBI_UNAVAILABLE");
  const p = Object.fromEntries(
    Object.entries({ ...params, wts: timestamp })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, String(v).replace(/[!'()*]/g, "")]),
  );
  const q = new URLSearchParams(p).toString();
  return {
    ...p,
    w_rid: createHash("md5")
      .update(q + mix)
      .digest("hex"),
  };
}
