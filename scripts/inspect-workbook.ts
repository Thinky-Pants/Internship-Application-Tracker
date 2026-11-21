import fs from "node:fs";
import { readWorkbook } from "../src/domain/import/xlsx";
const wb = readWorkbook(new Uint8Array(fs.readFileSync(process.argv[2])));
for (const s of wb.sheets) {
  console.log("=== SHEET", JSON.stringify(s.name), "rows", s.rows.length);
  s.rows.slice(0, 3).forEach((r, i) => console.log(i, JSON.stringify(r).slice(0, 1500)));
  const hdr = s.rows[0] ?? [];
  console.log("FILL", hdr.map((h, c) => `${h}:${s.rows.slice(1).filter((r) => r[c] != null).length}`).join(" | "));
}
