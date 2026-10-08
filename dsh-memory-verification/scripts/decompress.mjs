import { readFileSync, writeFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
const src = process.argv[2], out = process.argv[3];
const buf = readFileSync(src);
let text;
try { text = zstdDecompressSync(buf).toString("utf8"); }
catch (e) { console.log("zstd failed: " + e.message); process.exit(2); }
writeFileSync(out, text, "utf8");
const lines = text.split("\n").filter(Boolean);
console.log("decompressed bytes: " + text.length + ", jsonl lines: " + lines.length);
const kinds = {};
for (const l of lines) { try { const o = JSON.parse(l); const k = o.type || o.kind || o.role || "?"; kinds[k] = (kinds[k]||0)+1; } catch {} }
console.log(JSON.stringify(kinds, null, 2));
