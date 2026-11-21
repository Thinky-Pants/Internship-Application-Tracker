import Papa from "papaparse";
import { readWorkbook, type WorkbookGrid } from "./xlsx";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class UploadError extends Error {}

/** Validate type/size and parse an uploaded .xlsx or .csv into sheet grids. */
export function parseUpload(filename: string, bytes: Uint8Array): WorkbookGrid {
  if (bytes.byteLength === 0) throw new UploadError("The file is empty.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadError(`File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  const lower = filename.toLowerCase();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
    if (!isZip) throw new UploadError("This .xlsx file is not a valid Excel workbook.");
    return readWorkbook(bytes);
  }
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    if (isZip) throw new UploadError("This looks like an Excel file renamed to .csv.");
    let text = new TextDecoder("utf-8").decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const res = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    const rows = (res.data as string[][]).map((r) => r.map((c) => (c == null || String(c).trim() === "" ? null : String(c))));
    const name = filename.replace(/\.[^.]+$/, "") || "CSV";
    return { sheets: [{ name, rows }] };
  }
  if (lower.endsWith(".xls")) throw new UploadError("Legacy .xls is not supported — save the workbook as .xlsx.");
  throw new UploadError("Unsupported file type. Upload .xlsx or .csv.");
}
