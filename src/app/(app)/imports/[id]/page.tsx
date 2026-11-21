import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { loadBatch, planBatch } from "@/server/import-service";
import { getServices } from "@/server/runtime";
import { fieldsForRole } from "@/domain/import/mapping";
import { analyzeRollback } from "@/domain/import/commit";
import { planApolloCsv } from "@/domain/discovery/apollo-csv";
import { Badge, Button, Notice, PageHeader, Section, Stat } from "@/components/ui";
import { Flash } from "@/components/flash";
import { saveMappingAction, commitImportAction, rollbackImportAction } from "@/app/actions/imports";

export const metadata = { title: "Import" };

export default async function ImportDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const { id } = await params;
  const sp = await searchParams;
  let loaded;
  try {
    loaded = await loadBatch(owner.id, id);
  } catch (e) {
    return <Notice tone="danger" title="Could not read the stored file">{(e as Error).message}</Notice>;
  }
  if (!loaded) notFound();
  const { batch, grid, config } = loaded;
  const committed = batch.status !== "previewed";
  return (
    <>
      <PageHeader title={`Import: ${batch.filename}`} subtitle={<>Status <Badge>{batch.status.replace(/_/g, " ")}</Badge> · {grid.sheets.length} sheet(s) · SHA-256 {batch.fileSha256.slice(0, 12)}…</>} actions={<Link href="/imports">All imports</Link>} />
      <Flash sp={sp} />
      {!committed && (
        <form action={saveMappingAction}>
          <input type="hidden" name="batchId" value={batch.id} />
          <Section title="Step 2–3 · Sheets, roles and column mapping" actions={<Button type="submit" variant="primary">Save mapping & preview</Button>}>
            <div className="flex flex-col gap-4">
              {config.map((c, i) => {
                const sheet = grid.sheets.find((g) => g.name === c.sheet);
                const headers = sheet?.rows[c.headerRow] ?? [];
                return (
                  <fieldset key={c.sheet} className="rounded-md border border-line p-2">
                    <legend className="px-1 text-[13px] font-semibold">{c.sheet} <span className="font-normal text-muted">({Math.max(0, (sheet?.rows.length ?? 1) - c.headerRow - 1)} data rows)</span></legend>
                    <p className="mb-2 text-[12px] text-muted">{c.reason}</p>
                    <div className="mb-2 flex flex-wrap gap-3">
                      <div className="flex flex-col"><label htmlFor={`role-${i}`}>Role</label>
                        <select id={`role-${i}`} name={`role-${i}`} defaultValue={c.role}>
                          <option value="companies">Companies</option><option value="evidence">Research evidence</option><option value="apollo_contacts">Apollo contacts</option><option value="ignore">Ignore</option>
                        </select></div>
                      <div className="flex flex-col"><label htmlFor={`priority-${i}`}>Priority for rows</label>
                        <select id={`priority-${i}`} name={`priority-${i}`} defaultValue={c.priority}>{["primary", "reserve", "lead", "other"].map((p) => <option key={p}>{p}</option>)}</select></div>
                      <div className="flex flex-col"><label htmlFor={`header-${i}`}>Header row</label><input id={`header-${i}`} name={`header-${i}`} type="number" min={1} defaultValue={c.headerRow + 1} className="w-20" /></div>
                    </div>
                    {c.role !== "ignore" && (
                      <details open={i < 2}>
                        <summary className="cursor-pointer text-[12px]">Column mapping</summary>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {fieldsForRole(c.role).map((f) => (
                            <div key={f.key} className="flex flex-col">
                              <label htmlFor={`map-${i}-${f.key}`}>{f.label}</label>
                              <select id={`map-${i}-${f.key}`} name={`map-${i}-${f.key}`} defaultValue={c.mapping[f.key] ?? ""}>
                                <option value="">— not mapped —</option>
                                {headers.map((h, j) => <option key={j} value={j}>{h ?? `Column ${j + 1}`}</option>)}
                              </select>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    <details className="mt-2"><summary className="cursor-pointer text-[12px]">Header preview</summary>
                      <div className="overflow-x-auto"><table className="data text-[11px]"><tbody>{(sheet?.rows ?? []).slice(c.headerRow, c.headerRow + 4).map((r, ri) => <tr key={ri}>{r.slice(0, 12).map((v, ci) => <td key={ci} className="max-w-[160px] truncate">{v}</td>)}</tr>)}</tbody></table></div>
                    </details>
                  </fieldset>
                );
              })}
            </div>
          </Section>
        </form>
      )}
      <div className="mt-3">{batch.kind === "apollo_csv" ? <ApolloPreview ownerId={owner.id} batchId={batch.id} grid={grid} config={config} committed={committed} /> : <WorkbookPreview ownerId={owner.id} batch={batch} grid={grid} config={config} committed={committed} />}</div>
    </>
  );
}

async function WorkbookPreview({ ownerId, batch, grid, config, committed }: { ownerId: string; batch: typeof s.importBatches.$inferSelect; grid: Awaited<ReturnType<typeof loadBatch>> extends infer T ? T extends { grid: infer G } ? G : never : never; config: NonNullable<Awaited<ReturnType<typeof loadBatch>>>["config"]; committed: boolean }) {
  if (committed) {
    const r = batch.report as Record<string, unknown>;
    const rows = await getDb().select().from(s.importRows).where(eq(s.importRows.batchId, batch.id));
    const issues = rows.filter((x) => (x.issues as string[]).length);
    let analysis = null;
    if (batch.status === "committed") analysis = await analyzeRollback(getDb(), ownerId, batch.id).catch(() => null);
    const rb = r.rollback as { removed: number; fieldsReverted: number; kept: { companyId: string; companyName: string; reasons: string[] }[] } | undefined;
    return (
      <Section title="Step 6 · Commit report">
        <div className="mb-3 flex flex-wrap gap-2">
          {["added", "updated", "unchanged", "merged", "duplicatesForReview", "invalid", "evidenceUpserted", "evidenceUnmatched", "conflictsKept", "conflictsTakenIncoming", "emailsAdded"].map((k) => <Stat key={k} label={k.replace(/([A-Z])/g, " $1").toLowerCase()} value={String(r[k] ?? 0)} />)}
        </div>
        <p className="text-[13px]"><a href={`/api/imports/${batch.id}/errors.csv`}>Download issues & errors ({issues.length} rows)</a> · <Link href="/imports?tab=duplicates">Review duplicates</Link> · <Link href="/companies">Open companies</Link></p>
        {analysis && (
          <div className="mt-3 rounded-md border border-line p-2 text-[13px]">
            <p className="font-medium">Roll back this import</p>
            <p className="text-muted">Safe rollback removes {analysis.removable.length} companies created by this import that have not been touched since, and reverts {analysis.revertableFields} imported field values where they still equal what was imported. {analysis.dependencies.length} companies have later work and will be kept for manual correction.</p>
            {analysis.dependencies.length > 0 && <ul className="mt-1 text-[12px]">{analysis.dependencies.slice(0, 20).map((d) => <li key={d.companyId}><Link href={`/companies/${d.companyId}`}>{d.companyName}</Link>: {d.reasons.join(", ")}</li>)}</ul>}
            <form action={rollbackImportAction} className="mt-2"><input type="hidden" name="batchId" value={batch.id} /><Button variant="danger" type="submit">Roll back safely</Button></form>
          </div>
        )}
        {rb && <Notice tone="warn" title="Rolled back">Removed {rb.removed}, reverted {rb.fieldsReverted} fields. Kept {rb.kept.length}: {rb.kept.map((k) => k.companyName).join(", ")}</Notice>}
      </Section>
    );
  }
  const plan = await planBatch(ownerId, grid, config);
  const conflicts = plan.rows.filter((r) => r.conflicts.length);
  const pct = (n: number) => n.toLocaleString();
  return (
    <form action={commitImportAction}>
      <input type="hidden" name="batchId" value={batch.id} />
      <Section title="Step 4–5 · Normalisation & preview (nothing written yet)" actions={<Button type="submit" variant="primary">Commit import</Button>}>
        <div className="mb-3 flex flex-wrap gap-2">
          <Stat label="New companies" value={pct(plan.counts.add)} />
          <Stat label="Updates" value={pct(plan.counts.update)} />
          <Stat label="Unchanged" value={pct(plan.counts.unchanged)} />
          <Stat label="Merged within file" value={pct(plan.counts.merge_in_batch)} hint="e.g. a Lead that is also in Companies" />
          <Stat label="Possible duplicates" value={pct(plan.counts.duplicate_review)} hint="kept for review" />
          <Stat label="Invalid rows" value={pct(plan.counts.invalid)} />
          <Stat label="Evidence rows" value={pct(plan.counts.evidence)} />
          <Stat label="Distinct companies after" value={pct(plan.counts.distinctCompaniesAfter)} />
        </div>
        <p className="mb-2 text-[12px] text-muted">Rows by priority in this file: {Object.entries(plan.counts.byPriority).map(([k, v]) => `${k} ${v}`).join(" · ")}. Sheets: {plan.sheets.map((x) => `${x.sheet} (${x.role}, ${x.dataRows} rows)`).join("; ")}.</p>
        {conflicts.length > 0 && (
          <details open className="mb-3"><summary className="cursor-pointer text-[13px] font-medium">Field conflicts ({conflicts.reduce((a, r) => a + r.conflicts.length, 0)}) — existing values are kept unless you tick “use incoming”</summary>
            <table className="data mt-2"><thead><tr><th>Row</th><th>Field</th><th>Existing</th><th>Incoming</th><th>Reason</th><th>Use incoming</th></tr></thead>
              <tbody>{conflicts.flatMap((r) => r.conflicts.map((c) => (
                <tr key={`${r.key}:${c.field}`}><td>{r.key}</td><td>{c.field}</td><td className="max-w-xs truncate">{String(c.existing ?? "")}</td><td className="max-w-xs truncate">{String(c.incoming ?? "")}</td><td>{c.reason === "manual_edit" ? "edited in app" : "existing is newer"}</td>
                  <td><input type="checkbox" name="take" value={`${r.key}:${c.field}`} aria-label={`Use incoming ${c.field} for ${r.key}`} /></td></tr>
              )))}</tbody></table>
          </details>
        )}
        <PreviewList title="Possible duplicates (not merged)" rows={plan.rows.filter((r) => r.action === "duplicate_review").map((r) => `${r.key}: ${r.incoming?.fields.name} — ${r.duplicate?.reason}`)} />
        <PreviewList title="Invalid rows" rows={plan.rows.filter((r) => r.action === "invalid").map((r) => `${r.key}: ${r.issues.join(" ")}`)} />
        <PreviewList title="Unresolved / normalisation notes" rows={plan.rows.filter((r) => r.issues.length && r.action !== "invalid" && r.action !== "merge_in_batch").map((r) => `${r.key} ${r.incoming?.fields.name ?? ""}: ${r.issues.join(" ")}`)} />
        <PreviewList title="Updates (field changes)" rows={plan.rows.filter((r) => r.action === "update").map((r) => `${r.key} ${r.incoming?.fields.name}: ${r.changes.map((c) => c.field).join(", ") || "alias ID"}`)} />
        <p className="mt-2 text-[11px] text-muted">An “Outreach_Status” column is stored as imported history only; a populated email cell never implies that an email was sent.</p>
      </Section>
    </form>
  );
}

function PreviewList({ title, rows }: { title: string; rows: string[] }) {
  if (!rows.length) return null;
  return (
    <details className="mb-2"><summary className="cursor-pointer text-[13px]">{title} ({rows.length})</summary>
      <ul className="mt-1 max-h-64 overflow-y-auto text-[12px]">{rows.slice(0, 500).map((r, i) => <li key={i}>{r}</li>)}</ul>
    </details>
  );
}

async function ApolloPreview({ ownerId, batchId, grid, config, committed }: { ownerId: string; batchId: string; grid: { sheets: { rows: (string | null)[][] }[] }; config: NonNullable<Awaited<ReturnType<typeof loadBatch>>>["config"]; committed: boolean }) {
  if (committed) {
    const [b] = await getDb().select().from(s.importBatches).where(eq(s.importBatches.id, batchId));
    const r = b.report as { created: number; updated: number; skipped: number; emailsAdded: number; unresolvedCompanies: string[] };
    return <Section title="Apollo CSV report"><p className="text-[13px]">{r.created} created · {r.updated} updated · {r.emailsAdded} addresses · {r.skipped} skipped</p>{r.unresolvedCompanies?.length > 0 && <p className="mt-1 text-[12px]">Unresolved companies: {[...new Set(r.unresolvedCompanies)].join(", ")}</p>}</Section>;
  }
  const c = config[0];
  const rows = grid.sheets[0].rows;
  const plan = await planApolloCsv(getServices(), ownerId, rows[c.headerRow] ?? [], rows.slice(c.headerRow + 1), c.mapping);
  return (
    <form action={commitImportAction}>
      <input type="hidden" name="batchId" value={batchId} />
      <Section title="Apollo CSV preview" actions={<Button type="submit" variant="primary">Commit</Button>}>
        <p className="mb-2 text-[12px] text-muted">Company matching uses domain first; name-only matches are flagged. The person’s city/country is stored on the contact and never changes the company location. Provider email status is kept verbatim and only “verified” maps to provider-verified.</p>
        <table className="data"><thead><tr><th>Row</th><th>Person</th><th>Email / status</th><th>Company match</th><th>Action</th><th>Notes</th></tr></thead>
          <tbody>{plan.slice(0, 300).map((r) => (
            <tr key={r.rowNumber}><td>{r.rowNumber}</td><td>{r.name}<div className="text-[11px] text-muted">{r.title}</div></td><td className="text-[12px]">{r.email ?? "—"} {r.emailStatus && `(${r.emailStatus} → ${r.quality})`}</td>
              <td className="text-[12px]">{r.companyMatch ? `${r.companyMatch.companyName} (${r.companyMatch.how})` : <span className="text-warn">unresolved: {r.unresolvedCompany}</span>}</td><td>{r.contactAction}</td><td className="text-[11px]">{r.issues.join(" ")}</td></tr>
          ))}</tbody></table>
      </Section>
    </form>
  );
}
