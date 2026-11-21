import fs from "node:fs";
import { readWorkbook } from "../src/domain/import/xlsx";
const wb = readWorkbook(new Uint8Array(fs.readFileSync(process.argv[2])));
const want: Record<string,string[]> = { Companies: ["Geographical_Group","HQ_Country_or_Territory","Primary_Industry","Match_Tier","Outreach_Status","Internship_Evidence_Status","International_Eligibility_Status"], Leads: ["Geographical_Group","Primary_Industry","Promotion_Status","Outreach_Status","Website_Check","Israel_Screen"], Sources:["Field_Supported"] };
for (const s of wb.sheets) {
  if (!want[s.name]) continue;
  const hdr = s.rows[0];
  for (const col of want[s.name]) {
    const c = hdr.indexOf(col); const m = new Map<string,number>();
    for (const r of s.rows.slice(1)) { const v = r[c] ?? "(blank)"; m.set(v,(m.get(v)??0)+1); }
    console.log(s.name, col, JSON.stringify([...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25)));
  }
  const dc = hdr.indexOf("Canonical_Domain"); if (dc>=0){ const m=new Map<string,number>(); s.rows.slice(1).forEach(r=>m.set(r[dc]!,(m.get(r[dc]!)??0)+1)); console.log(s.name,"dup domains",[...m.entries()].filter(e=>e[1]>1).length); }
}
