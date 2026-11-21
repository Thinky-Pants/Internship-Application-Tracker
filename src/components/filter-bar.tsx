import { saveViewAction } from "@/app/actions/companies";
import { describeFilter, type CompanyFilter } from "@/server/queries";
import { Button } from "./ui";

const sel = (name: string, value: string | undefined, opts: [string, string][], label: string) => (
  <div className="flex flex-col gap-0.5">
    <label htmlFor={`f-${name}`}>{label}</label>
    <select id={`f-${name}`} name={name} defaultValue={value ?? ""}>
      <option value="">Any</option>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </div>
);

export function FilterBar({ f, options, action, views }: { f: CompanyFilter; options: { industries: string[]; regions: string[]; countries: string[] }; action: string; views: { id: string; name: string; qs: string }[] }) {
  return (
    <div className="mb-3 rounded-lg border border-line bg-surface p-3">
      <form method="get" action={action} className="flex flex-wrap items-end gap-2" aria-label="Filter companies">
        <div className="flex flex-col gap-0.5"><label htmlFor="f-q">Search</label><input id="f-q" name="q" defaultValue={f.q} placeholder="Name or domain" className="w-44" /></div>
        {sel("priority", f.priority, [["primary", "Primary"], ["reserve", "Reserve"], ["lead", "Lead"], ["other", "Other"]], "Priority")}
        {sel("industry", f.industry, options.industries.map((x) => [x, x]), "Industry")}
        {sel("region", f.region, options.regions.map((x) => [x, x]), "Region")}
        {sel("country", f.country, options.countries.map((x) => [x, x]), "Country")}
        {sel("email", f.email, [["missing", "No email"], ["available", "Any address"], ["usable", "Usable address"], ["verified", "Provider-verified"]], "Email")}
        {sel("progress", f.progress, [["not_contacted", "Not contacted"], ["drafting", "Drafting"], ["ready", "Ready"], ["scheduled", "Scheduled"], ["contacted", "Awaiting reply"], ["replied", "Replied"], ["interviewing", "Interview/offer"], ["closed", "Closed"]], "Outreach")}
        {sel("discovery", f.discovery, [["not_researched", "Not researched"], ["searching", "Searching"], ["candidate_found", "Candidate found"], ["reviewed", "Reviewed"], ["no_suitable_match", "No suitable match"]], "Discovery")}
        {sel("stage", f.stage, [["prospect", "Prospect"], ["applied_contacted", "Applied/contacted"], ["screening", "Screening"], ["interview", "Interview"], ["offer", "Offer"], ["rejected", "Rejected"], ["withdrawn", "Withdrawn"], ["closed", "Closed"]], "Opportunity")}
        <div className="flex flex-col gap-0.5"><label htmlFor="f-role">Contact role</label><input id="f-role" name="role" defaultValue={f.role} placeholder="e.g. founder" className="w-28" /></div>
        {sel("activity", f.activity, [["7", "Active ≤7 days"], ["30", "Active ≤30 days"], ["stale30", "No activity 30+ days"], ["never", "No activity"]], "Last activity")}
        {sel("followup", f.followup, [["due", "Due within 7 days"], ["overdue", "Overdue"]], "Follow-up")}
        {sel("demo", f.demo, [["hide", "Hide demo"], ["only", "Demo only"]], "Demo data")}
        <Button type="submit" variant="primary">Apply</Button>
        <a href={action} className="text-[13px]">Clear</a>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-muted">Showing: {describeFilter(f)}</span>
        <form action={saveViewAction} className="flex items-center gap-1">
          <input type="hidden" name="qs" value={JSON.stringify(f)} />
          <input type="hidden" name="back" value={action} />
          <label htmlFor="view-name" className="sr-only">Saved view name</label>
          <input id="view-name" name="name" placeholder="Save this view as…" className="w-48 py-0.5" required />
          <Button type="submit">Save view</Button>
        </form>
        {views.length > 0 && <span className="text-muted">Saved:</span>}
        {views.map((v) => <a key={v.id} href={`${action}${v.qs}`}>{v.name}</a>)}
      </div>
    </div>
  );
}
