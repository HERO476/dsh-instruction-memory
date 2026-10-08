import { readFileSync, writeFileSync } from "node:fs";
const f = process.argv[2];
const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "");
const out = [];
for (const l of lines) {
  const o = JSON.parse(l);
  if (o.type === "request/header" || o.type === "system/message" || o.type === "request/context") {
    out.push({ type: o.type, keys: Object.keys(o), size: JSON.stringify(o).length, sample: JSON.stringify(o).slice(0, 400) });
  }
}
console.log(JSON.stringify(out, null, 2));
