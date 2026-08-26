// Minimal port of streetlevel's (https://github.com/sk-zk/streetlevel) pseudo-protobuf
// URL encoder used by Google Maps' internal endpoints (`!1m2!2sfoo!3d1.5` etc).

export class Enum {
  constructor(value) { this.value = value; }
}

// Forces "double" wire type even for integer-valued numbers (Python's protobuf encoder
// distinguishes int vs float; JS numbers don't, so radius=50 must be tagged explicitly
// or Google's endpoint silently rejects the request).
export class Dbl {
  constructor(value) { this.value = value; }
}

function fieldToString(tag, value) {
  if (Array.isArray(value)) {
    let serialized = "";
    let childCount = 0;
    for (const entry of value) {
      const [c, s] = fieldToString(tag, entry);
      serialized += s;
      childCount += c;
    }
    return [childCount, serialized];
  }
  if (value instanceof Enum) return [1, `!${tag}e${value.value}`];
  if (value instanceof Dbl) return [1, `!${tag}d${value.value}`];
  if (typeof value === "boolean") return [1, `!${tag}b${value ? 1 : 0}`];
  if (typeof value === "number") {
    const type = Number.isInteger(value) ? "i" : "d";
    return [1, `!${tag}${type}${value}`];
  }
  if (typeof value === "string") return [1, `!${tag}s${value}`];
  if (typeof value === "object") {
    const [subChildCount, subSerialized] = toProtobufUrl(value);
    return [subChildCount + 1, `!${tag}m${subChildCount}${subSerialized}`];
  }
  throw new Error(`unsupported value: ${value}`);
}

export function toProtobufUrl(fields) {
  let serialized = "";
  let childCount = 0;
  for (const [tag, value] of Object.entries(fields)) {
    const [c, s] = fieldToString(tag, value);
    serialized += s;
    childCount += c;
  }
  return [childCount, serialized];
}

export const UA = "Mozilla/5.0 (Windows NT 11.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0";

export async function fetchGoogleJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "*/*", Referer: "https://www.google.com/", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
  let text = await res.text();
  if (text.startsWith(")]}'")) text = text.slice(4);
  return JSON.parse(text);
}
