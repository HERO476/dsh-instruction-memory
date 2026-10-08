import { readFileSync, writeFileSync } from "node:fs";
import { zstdDecompressSync, createZstdDecompress } from "node:zlib";
const src = process.argv[2], out = process.argv[3];
const buf = readFileSync(src);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
let i = buf.indexOf(MAGIC, 0);
while (i !== -1) { offsets.push(i); i = buf.indexOf(MAGIC, i + 1); }
console.log("zstd frame candidates: " + offsets.length + " (file " + buf.length + " bytes)");
let merged = "", okFrames = 0, badFrames = 0;
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k];
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
  try { merged += zstdDecompressSync(buf.subarray(start, end)).toString("utf8"); okFrames++; }
  catch { badFrames++; }
}
console.log("frames ok=" + okFrames + " bad=" + badFrames + " merged chars=" + merged.length);
writeFileSync(out, merged, "utf8");
const lines = merged.split("\n").filter((l) => l.trim() !== "");
const kinds = {};
let parseErr = 0;
for (const l of lines) { try { const o = JSON.parse(l); const k = o.type || o.kind || "?"; kinds[k] = (kinds[k]||0)+1; } catch { parseErr++; } }
console.log("jsonl lines: " + lines.length + ", parse errors: " + parseErr);
console.log(JSON.stringify(kinds, null, 2));
