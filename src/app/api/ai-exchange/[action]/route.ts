import { getServices } from "@/server/runtime";
import { apiOwner, download, handler } from "@/server/http";
import { listCompanies } from "@/server/queries";
import { exportPackage, type ExchangeTask } from "@/domain/ai/exchange";

const TASKS: ExchangeTask[] = ["draft_email", "contact_priorities", "research_facts", "suggest_cv"];

export const GET = handler(async (req: Request, ctx: { params: Promise<{ action: string }> }) => {
  const owner = await apiOwner();
  const { action } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const svc = getServices();
  if (action === "export") {
    const task = (TASKS.includes(sp.get("task") as ExchangeTask) ? sp.get("task") : "draft_email") as ExchangeTask;
    const filter = sp.get("filter");
    const rows = await listCompanies(owner.id, filter === "ready" ? { email: "usable", progress: "not_contacted" } : filter === "missing" ? { priority: "primary", email: "missing" } : {});
    const ids = (sp.getAll("id").length ? sp.getAll("id") : rows.slice(0, 50).map((r) => r.company.id)).slice(0, 50);
    const pkg = await exportPackage(svc, owner.id, task, ids);
    return download(JSON.stringify(pkg, null, 2), `ai-exchange-${task}-${pkg.packageId.slice(0, 8)}.json`, "application/json");
  }
  if (action === "sample") {
    const sample = {
      note: "Example only. Real packages are generated from your records; results must reuse the packageId, recordId and recordRevision exactly.",
      package: { schema: "iom.ai-exchange/v1", packageId: "00000000-0000-4000-8000-000000000001", task: "draft_email", prompt: "…ready-to-paste instructions…", records: [{ recordType: "company", recordId: "00000000-0000-4000-8000-0000000000aa", recordRevision: 3, data: { name: "Example Robotics", industry: "Robotics" }, contacts: [], evidence: [{ id: "…", url: "https://example.com/about", summary: "Builds grippers." }] }] },
      resultLine: { packageId: "00000000-0000-4000-8000-000000000001", recordType: "company", recordId: "00000000-0000-4000-8000-0000000000aa", recordRevision: 3, result: { subject: "Summer 2027 internship — Example Robotics", bodyHtml: "<p>Dear …</p>", usedEvidenceIds: ["…"], unsupportedClaims: [] } },
    };
    return download(JSON.stringify(sample, null, 2), "ai-exchange-sample.json", "application/json");
  }
  return new Response("Not found", { status: 404 });
});
