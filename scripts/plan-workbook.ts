import fs from "node:fs";
import { parseUpload } from "../src/domain/import/parse";
import { suggestMapping, suggestSheetRole } from "../src/domain/import/mapping";
import { planImport } from "../src/domain/import/planner";
const file = process.argv[2];
const wb = parseUpload(file, new Uint8Array(fs.readFileSync(file)));
const sheets = wb.sheets.map((s) => { const sug = suggestSheetRole(s.name, s.rows[0] ?? []); console.log(s.name, "->", sug.role, sug.priority, "|", sug.reason); return { config: { sheet: s.name, role: sug.role, priority: sug.priority, headerRow: 0, mapping: suggestMapping(s.rows[0] ?? [], sug.role) }, rows: s.rows }; });
const plan = planImport({ sheets, existing: [] });
console.log(JSON.stringify(plan.counts), JSON.stringify(plan.sheets));
const issues = new Map<string, number>(); for (const r of plan.rows) for (const i of r.issues) { const k = i.replace(/"[^"]*"/g, '"…"').replace(/#\d+/g, "#n"); issues.set(k, (issues.get(k) ?? 0) + 1); }
console.log([...issues.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 15));
console.log(JSON.stringify(sheets.find(s=>s.config.sheet==="Leads")!.config.mapping));
