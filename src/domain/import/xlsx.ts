/**
 * Minimal, dependency-light XLSX reader (zip + XML).
 *
 * Why not exceljs/SheetJS: exceljs fails on workbooks whose relationships use
 * absolute part targets (e.g. "/xl/worksheets/sheet1.xml", common for files
 * written by the OpenXML SDK / ClosedXML), and the npm-registry SheetJS build
 * is outdated. Reading cell values only needs a small, auditable subset of
 * SpreadsheetML, implemented here.
 *
 * Output: every sheet as a grid of strings (or null for empty cells). IDs and
 * numbers stay as their textual representation so long identifiers are not
 * rounded; date-formatted cells become ISO dates.
 */
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

export interface SheetGrid {
  name: string;
  rows: (string | null)[][];
}

export interface WorkbookGrid {
  sheets: SheetGrid[];
}

export const MAX_SHEET_ROWS = 50_000;
export const MAX_SHEET_COLS = 200;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  textNodeName: "#text",
  isArray: (name) => ["sheet", "Relationship", "si", "r", "row", "c", "xf", "numFmt"].includes(name),
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("#text" in o) return String(o["#text"] ?? "");
  }
  return "";
}

function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (baseDir ? baseDir.split("/") : []).concat(target.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function relsPathFor(partPath: string): string {
  const dir = dirOf(partPath);
  const file = partPath.slice(dir.length ? dir.length + 1 : 0);
  return (dir ? dir + "/" : "") + "_rels/" + file + ".rels";
}

const BUILTIN_DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormatCode(code: string): boolean {
  const cleaned = code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "").replace(/\\./g, "");
  return /[dmy]/i.test(cleaned) && !/^[#0.,%E+\- ]*$/i.test(cleaned);
}

function excelSerialToIso(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = epoch + Math.round(serial * 86400000);
  const d = new Date(ms);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19) + "Z";
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) n = n * 26 + (code - 64);
    else if (code >= 97 && code <= 122) n = n * 26 + (code - 96);
    else break;
  }
  return n - 1;
}

export function readWorkbook(bytes: Uint8Array): WorkbookGrid {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("File is not a valid .xlsx (zip) package.");
  }
  // Normalise keys (some writers use backslashes or leading slashes).
  const byPath = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(files)) byPath.set(k.replace(/\\/g, "/").replace(/^\//, ""), v);
  const read = (p: string) => {
    const f = byPath.get(p) ?? [...byPath.entries()].find(([k]) => k.toLowerCase() === p.toLowerCase())?.[1];
    return f ? strFromU8(f) : null;
  };

  // Locate workbook part via package relationships.
  let workbookPath = "xl/workbook.xml";
  const rootRels = read("_rels/.rels");
  if (rootRels) {
    const rels = asArray(parser.parse(rootRels)?.Relationships?.Relationship);
    const office = rels.find((r: any) => String(r["@_Type"]).endsWith("/officeDocument"));
    if (office) workbookPath = resolveTarget("", String(office["@_Target"]));
  }
  const workbookXml = read(workbookPath);
  if (!workbookXml) throw new Error("Workbook part not found in package.");
  const wbDoc = parser.parse(workbookXml)?.workbook;
  const date1904 = String(wbDoc?.workbookPr?.["@_date1904"] ?? "") === "1" || String(wbDoc?.workbookPr?.["@_date1904"]) === "true";
  const sheetDefs = asArray(wbDoc?.sheets?.sheet).map((s: any) => ({
    name: String(s["@_name"]),
    rid: String(s["@_id"] ?? s["@_r:id"] ?? ""),
  }));

  const wbDir = dirOf(workbookPath);
  const wbRelsXml = read(relsPathFor(workbookPath));
  const wbRels = new Map<string, { type: string; target: string }>();
  if (wbRelsXml) {
    for (const r of asArray(parser.parse(wbRelsXml)?.Relationships?.Relationship) as any[]) {
      wbRels.set(String(r["@_Id"]), { type: String(r["@_Type"]), target: resolveTarget(wbDir, String(r["@_Target"])) });
    }
  }

  // Shared strings.
  const sharedStrings: string[] = [];
  const ssRel = [...wbRels.values()].find((r) => r.type.endsWith("/sharedStrings"));
  const ssXml = read(ssRel?.target ?? resolveTarget(wbDir, "sharedStrings.xml"));
  if (ssXml) {
    for (const si of asArray(parser.parse(ssXml)?.sst?.si) as any[]) {
      if (si.t !== undefined) sharedStrings.push(textOf(si.t));
      else sharedStrings.push(asArray(si.r).map((run: any) => textOf(run.t)).join(""));
    }
  }

  // Styles → which cell style indexes are dates.
  const dateStyle = new Set<number>();
  const stRel = [...wbRels.values()].find((r) => r.type.endsWith("/styles"));
  const stXml = read(stRel?.target ?? resolveTarget(wbDir, "styles.xml"));
  if (stXml) {
    const st = parser.parse(stXml)?.styleSheet;
    const custom = new Map<number, string>();
    for (const nf of asArray(st?.numFmts?.numFmt) as any[]) custom.set(Number(nf["@_numFmtId"]), String(nf["@_formatCode"] ?? ""));
    asArray(st?.cellXfs?.xf).forEach((xf: any, idx: number) => {
      const id = Number(xf["@_numFmtId"] ?? 0);
      if (BUILTIN_DATE_FMT_IDS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!))) dateStyle.add(idx);
    });
  }

  const sheets: SheetGrid[] = [];
  for (const def of sheetDefs) {
    const rel = wbRels.get(def.rid);
    if (!rel || !rel.type.endsWith("/worksheet")) continue; // chartsheets etc.
    const xml = read(rel.target);
    if (!xml) continue;
    const ws = parser.parse(xml)?.worksheet;
    const rows: (string | null)[][] = [];
    let implicitRow = 0;
    for (const row of asArray(ws?.sheetData?.row) as any[]) {
      const rIdx = row["@_r"] ? Number(row["@_r"]) - 1 : implicitRow;
      implicitRow = rIdx + 1;
      if (rIdx >= MAX_SHEET_ROWS) throw new Error(`Sheet "${def.name}" exceeds ${MAX_SHEET_ROWS} rows.`);
      const out: (string | null)[] = rows[rIdx] ?? [];
      let implicitCol = 0;
      for (const c of asArray(row.c) as any[]) {
        const ci = c["@_r"] ? colIndex(String(c["@_r"])) : implicitCol;
        implicitCol = ci + 1;
        if (ci >= MAX_SHEET_COLS) continue;
        const t = String(c["@_t"] ?? "n");
        const raw = c.v !== undefined ? textOf(c.v) : null;
        let val: string | null = null;
        if (t === "s") val = raw == null ? null : sharedStrings[Number(raw)] ?? null;
        else if (t === "inlineStr") val = c.is?.t !== undefined ? textOf(c.is.t) : asArray(c.is?.r).map((x: any) => textOf(x.t)).join("");
        else if (t === "b") val = raw == null ? null : raw === "1" ? "TRUE" : "FALSE";
        else if (t === "e") val = null; // formula errors are treated as empty
        else if (t === "d") val = raw;
        else if (t === "str") val = raw;
        else {
          // numeric
          const style = Number(c["@_s"] ?? 0);
          if (raw != null && raw !== "" && dateStyle.has(style) && !Number.isNaN(Number(raw))) val = excelSerialToIso(Number(raw), date1904);
          else val = raw;
        }
        out[ci] = val != null && val.trim() !== "" ? val : null;
      }
      rows[rIdx] = out;
    }
    // Fill holes so the grid is dense.
    const width = rows.reduce((m, r) => Math.max(m, r ? r.length : 0), 0);
    const dense = Array.from({ length: rows.length }, (_, i) => {
      const r = rows[i] ?? [];
      return Array.from({ length: width }, (_, j) => r[j] ?? null);
    });
    sheets.push({ name: def.name, rows: dense });
  }
  return { sheets };
}
