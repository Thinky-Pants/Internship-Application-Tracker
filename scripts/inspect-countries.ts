import fs from "node:fs";
import { readWorkbook } from "../src/domain/import/xlsx";
const wb = readWorkbook(new Uint8Array(fs.readFileSync(process.argv[2])));
const m = new Map<string, number>();
for (const s of wb.sheets) { const c = s.rows[0]?.indexOf("HQ_Country_or_Territory") ?? -1; if (c < 0) continue; for (const r of s.rows.slice(1)) m.set(r[c] ?? "(blank)", (m.get(r[c] ?? "(blank)") ?? 0) + 1); }
console.log([...m.keys()].sort().join("|"));
