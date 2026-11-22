import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { companySummary } from "@/domain/summary";
import { DEFAULT_ROLE_HEURISTICS, suggestFilters, type RoleHeuristics } from "@/domain/discovery/service";
import { suggestTimezone } from "@/domain/normalize";
import { Badge, Button, Field, fmtDate, LinkButton, Notice, PageHeader, ProgressBadge, QualityBadge, Section, StateBadge } from "@/components/ui";
import { Flash } from "@/components/flash";
import {
  addContactAction, addEmailAction, addReminderAction, apolloSearchAction, closeCompanyAction, enrichContactAction, saveCandidatesAction,
  setLocationAction, setPreferredContactAction, setTimezoneAction, suppressCompanyAction, suppressEmailAction, updateCompanyAction, upsertOpportunityAction,
} from "@/app/actions/companies";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner();
  const { id } = await params;
  const [c] = await getDb().select({ name: s.companies.name }).from(s.companies).where(and(eq(s.companies.id, id), eq(s.companies.ownerId, owner.id)));
  return { title: c?.name ?? "Company" };
}

const STAGES = ["prospect", "applied_contacted", "screening", "interview", "offer", "rejected", "withdrawn", "closed"];

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const [c] = await db.select().from(s.companies).where(and(eq(s.companies.id, id), eq(s.companies.ownerId, owner.id)));
  if (!c) notFound();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const zone = st.displayTimezone;
  const [summary, locations, contacts, emails, opps, msgs, attempts, evidence, tasks, extIds, mailboxes, audits] = await Promise.all([
    companySummary(db, id),
    db.select().from(s.companyLocations).where(eq(s.companyLocations.companyId, id)),
    db.select().from(s.contacts).where(eq(s.contacts.companyId, id)),
    db.select().from(s.emailAddresses).where(eq(s.emailAddresses.companyId, id)),
    db.select().from(s.opportunities).where(eq(s.opportunities.companyId, id)),
    db.select().from(s.messages).where(eq(s.messages.companyId, id)).orderBy(desc(s.messages.createdAt)),
    db.select().from(s.discoveryAttempts).where(eq(s.discoveryAttempts.companyId, id)).orderBy(desc(s.discoveryAttempts.createdAt)),
    db.select().from(s.companyEvidence).where(eq(s.companyEvidence.companyId, id)),
    db.select().from(s.tasks).where(and(eq(s.tasks.companyId, id), eq(s.tasks.status, "open"))),
    db.select().from(s.companyExternalIds).where(eq(s.companyExternalIds.companyId, id)),
    db.select().from(s.mailboxes).where(eq(s.mailboxes.ownerId, owner.id)),
    db.select().from(s.auditEvents).where(and(eq(s.auditEvents.entityType, "company"), eq(s.auditEvents.entityId, id))).orderBy(desc(s.auditEvents.at)).limit(30),
  ]);
  const sends = msgs.length ? await db.select().from(s.scheduledSends).where(inArray(s.scheduledSends.messageId, msgs.map((m) => m.id))) : [];
  const qevents = sends.length ? await db.select().from(s.queueEvents).where(inArray(s.queueEvents.scheduledSendId, sends.map((x) => x.id))).orderBy(desc(s.queueEvents.at)).limit(50) : [];
  const mbName = (mid: string | null) => mailboxes.find((m) => m.id === mid)?.emailAddress ?? "—";
  const contacted = msgs.filter((m) => m.direction === "outbound" && (m.recordedSentAt || m.submittedAt || m.kind === "external_sent"));
  const contactedPeople = new Set(contacted.map((m) => m.contactId).filter(Boolean));
  const activeSends = sends.filter((x) => ["scheduled", "held", "paused", "dispatching"].includes(x.state));
  const pendingPeople = new Set(msgs.filter((m) => activeSends.some((x) => x.messageId === m.id)).map((m) => m.contactId));
  const multiOutreach = new Set([...contactedPeople, ...pendingPeople]).size > 1;
  const heur = suggestFilters({ ...DEFAULT_ROLE_HEURISTICS, ...(st.roleHeuristics as Partial<RoleHeuristics>) }, c.sizeText);
  const lastSearch = attempts.find((a) => a.kind === "search");
  const primaryLoc = locations.find((l) => l.isPrimary) ?? locations[0];
  const tzSug = suggestTimezone(c.country, c.city);
  const timeline = [
    ...msgs.map((m) => ({ at: m.receivedAt ?? m.recordedSentAt ?? m.submittedAt ?? m.createdAt, text: `${m.direction === "inbound" ? "Received" : m.kind === "external_sent" ? "Sent from your mailbox directly" : `Outbound (${m.status.replace(/_/g, " ")})`}: ${m.subject ?? ""}`, href: m.direction === "inbound" && m.conversationId ? `/inbox/${m.conversationId}` : `/drafts/${m.id}` })),
    ...attempts.map((a) => ({ at: a.attemptedAt ?? a.createdAt, text: `Discovery ${a.kind} via ${a.provider}: ${a.status}${a.outcome ? ` / ${a.outcome.replace(/_/g, " ")}` : ""}`, href: undefined })),
    ...qevents.map((q) => ({ at: q.at, text: `Send ${q.fromState ?? "new"} → ${q.toState}${q.reason ? `: ${q.reason}` : ""}`, href: undefined })),
    ...audits.map((a) => ({ at: a.at, text: `${a.action.replace(/_/g, " ")} by ${a.actor}`, href: undefined })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 60);

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={<>
          {c.originalName && c.originalName !== c.name && <span>{c.originalName} · </span>}
          {c.website ? <a href={c.website} target="_blank" rel="noopener noreferrer">{c.domain}</a> : c.domain ?? "no website"} · {c.priority} priority
          {extIds.length > 0 && <span> · IDs: {extIds.map((e) => e.value).join(", ")}</span>}
        </>}
        actions={<>
          <ProgressBadge p={summary.outreach} />
          <LinkButton variant="primary" href={`/drafts/new?companyId=${c.id}${c.preferredContactId ? `&contactId=${c.preferredContactId}` : ""}`}>Prepare draft</LinkButton>
          <LinkButton href={`/map?q=${encodeURIComponent(c.name)}`}>Map</LinkButton>
        </>}
      />
      <Flash sp={sp} />
      {c.suppressed && <Notice tone="danger" title="Outreach suppressed">{c.suppressedReason}</Notice>}
      {multiOutreach && <div className="mb-3"><Notice tone="warn" title="Several people at this company">You have contacted or scheduled more than one person here. Simultaneous outreach to multiple people at a small company can look like spam — consider pausing one.</Notice></div>}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="flex flex-col gap-3 lg:col-span-2">
          <Section title="Contacts & email addresses">
            {contacts.length === 0 && <p className="text-[13px] text-muted">No contacts yet. Search Apollo below, import an Apollo CSV, or add one manually.</p>}
            {contacts.length > 0 && (
              <table className="data">
                <thead><tr><th>Person</th><th>Addresses</th><th>Contacted</th><th>Actions</th></tr></thead>
                <tbody>
                  {contacts.map((ct) => {
                    const em = emails.filter((e) => e.contactId === ct.id);
                    const sentTo = contacted.filter((m) => m.contactId === ct.id);
                    return (
                      <tr key={ct.id}>
                        <td>
                          <div className="font-medium">{ct.fullName} {ct.isPreferred && <Badge tone="info">primary</Badge>} {ct.suppressed && <Badge tone="danger">do not contact</Badge>}</div>
                          <div className="text-[12px] text-muted">{ct.title ?? "—"}{ct.seniority ? ` · ${ct.seniority}` : ""} · source {ct.source.replace(/_/g, " ")}</div>
                          {ct.personLocation && <div className="text-[11px] text-muted">Person location: {ct.personLocation} (not used for company location)</div>}
                          {ct.linkedinUrl && <a className="text-[12px]" href={ct.linkedinUrl} target="_blank" rel="noopener noreferrer">LinkedIn</a>}
                        </td>
                        <td>
                          {em.length === 0 ? <Badge>no address</Badge> : em.map((e) => (
                            <div key={e.id} className="mb-1 flex flex-wrap items-center gap-1">
                              <span className="font-mono text-[12px]">{e.address}</span>
                              <QualityBadge quality={e.quality} bounce={e.bounceState} />
                              {e.providerStatus && <span className="text-[11px] text-muted">provider: “{e.providerStatus}”</span>}
                              <span className="text-[11px] text-muted">via {e.source.replace(/_/g, " ")}</span>
                              {e.suppressed ? <Badge tone="danger">suppressed</Badge> : (
                                <form action={suppressEmailAction}><input type="hidden" name="companyId" value={c.id} /><input type="hidden" name="emailId" value={e.id} /><button className="text-[11px] text-danger underline" type="submit">suppress</button></form>
                              )}
                            </div>
                          ))}
                        </td>
                        <td className="text-[12px]">{sentTo.length ? sentTo.map((m) => <div key={m.id}>{fmtDate(m.recordedSentAt ?? m.submittedAt, zone)} from {mbName(m.mailboxId)}</div>) : "—"}</td>
                        <td className="flex flex-col gap-1">
                          {!ct.isPreferred && <form action={setPreferredContactAction}><input type="hidden" name="companyId" value={c.id} /><input type="hidden" name="contactId" value={ct.id} /><Button type="submit">Make primary</Button></form>}
                          {ct.apolloPersonId && !em.length && <form action={enrichContactAction}><input type="hidden" name="companyId" value={c.id} /><input type="hidden" name="contactId" value={ct.id} /><Button type="submit" title="Uses Apollo credits only if data is returned">Enrich email</Button></form>}
                          <LinkButton href={`/drafts/new?companyId=${c.id}&contactId=${ct.id}`}>Draft</LinkButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {emails.filter((e) => !e.contactId).length > 0 && (
              <div className="mt-2 text-[13px]"><span className="text-muted">Company addresses: </span>{emails.filter((e) => !e.contactId).map((e) => <span key={e.id} className="mr-2"><span className="font-mono">{e.address}</span> <QualityBadge quality={e.quality} bounce={e.bounceState} /></span>)}</div>
            )}
            <details className="mt-3">
              <summary className="cursor-pointer text-[13px] font-medium">Add contact or address</summary>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                <form action={addContactAction} className="flex flex-col gap-2">
                  <input type="hidden" name="companyId" value={c.id} />
                  <Field label="Full name" htmlFor="ac-name"><input id="ac-name" name="fullName" required /></Field>
                  <Field label="Title" htmlFor="ac-title"><input id="ac-title" name="title" /></Field>
                  <Field label="Email (optional)" htmlFor="ac-email"><input id="ac-email" name="email" type="email" /></Field>
                  <Field label="Source URL (if from the company website)" htmlFor="ac-src"><input id="ac-src" name="sourceUrl" type="url" /></Field>
                  <Field label="LinkedIn URL" htmlFor="ac-li"><input id="ac-li" name="linkedinUrl" type="url" /></Field>
                  <Button type="submit">Add contact</Button>
                </form>
                <form action={addEmailAction} className="flex flex-col gap-2">
                  <input type="hidden" name="companyId" value={c.id} />
                  <Field label="Address" htmlFor="ae-addr"><input id="ae-addr" name="address" type="email" required /></Field>
                  <Field label="For contact" htmlFor="ae-ct"><select id="ae-ct" name="contactId"><option value="">Company / general inbox</option>{contacts.map((ct) => <option key={ct.id} value={ct.id}>{ct.fullName}</option>)}</select></Field>
                  <Field label="Source" htmlFor="ae-src"><select id="ae-src" name="source"><option value="website">Company website</option><option value="manual">Other / manual</option></select></Field>
                  <Field label="Source URL" htmlFor="ae-url"><input id="ae-url" name="sourceUrl" type="url" /></Field>
                  <p className="text-[11px] text-muted">Manually added addresses are recorded as unverified.</p>
                  <Button type="submit">Add address</Button>
                </form>
              </div>
            </details>
          </Section>

          <Section title={<span id="discovery">Contact discovery (Apollo)</span>}>
            <p className="mb-2 text-[12px] text-muted">{heur.explanation} {DEFAULT_ROLE_HEURISTICS.note} People search returns candidates only; an address exists only after enrichment, CSV import or manual entry.</p>
            <form action={apolloSearchAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="companyId" value={c.id} />
              <Field label="Titles (comma-separated)" htmlFor="ap-t"><input id="ap-t" name="titles" defaultValue={heur.titles.slice(0, 8).join(", ")} className="w-96" /></Field>
              <Field label="Seniorities" htmlFor="ap-s"><input id="ap-s" name="seniorities" defaultValue={heur.seniorities.join(", ")} className="w-56" /></Field>
              <Button type="submit" disabled={!c.domain} title={c.domain ? "Search uses 0 credits per Apollo docs; it counts toward rate limits" : "Company has no domain"}>Search people</Button>
            </form>
            {lastSearch && (
              <div className="mt-3">
                <p className="text-[12px]">Last search {fmtDate(lastSearch.attemptedAt, zone)} via {lastSearch.provider}: <strong>{lastSearch.status}</strong>{lastSearch.outcome && ` / ${lastSearch.outcome.replace(/_/g, " ")}`}{lastSearch.errorMessage && <span className="text-danger"> — {lastSearch.errorMessage}</span>}</p>
                {(lastSearch.candidates as { apolloPersonId: string; fullName: string; title: string | null; hasEmailFlag: boolean | null; personLocation: string | null }[]).length > 0 && (
                  <form action={saveCandidatesAction} className="mt-2">
                    <input type="hidden" name="companyId" value={c.id} />
                    <input type="hidden" name="attemptId" value={lastSearch.id} />
                    <table className="data">
                      <thead><tr><th><span className="sr-only">Select</span></th><th>Candidate</th><th>Title</th><th>Apollo says</th></tr></thead>
                      <tbody>
                        {(lastSearch.candidates as { apolloPersonId: string; fullName: string; title: string | null; hasEmailFlag: boolean | null; personLocation: string | null }[]).map((cand) => (
                          <tr key={cand.apolloPersonId}>
                            <td><input type="checkbox" name="pick" value={cand.apolloPersonId} aria-label={`Select ${cand.fullName}`} /></td>
                            <td>{cand.fullName}{cand.personLocation && <div className="text-[11px] text-muted">{cand.personLocation}</div>}</td>
                            <td>{cand.title ?? "—"}</td>
                            <td className="text-[12px]">{cand.hasEmailFlag ? "has an email on file (not revealed)" : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-[13px] text-fg"><input type="checkbox" name="enrich" value="1" /> Also enrich selected (reveal business email; phone & personal email are never requested)</label>
                      <Field label="Credit budget for this run" htmlFor="budget"><input id="budget" name="budget" type="number" min={0} defaultValue={5} className="w-20" /></Field>
                      <Button type="submit" variant="primary">Save selected</Button>
                    </div>
                  </form>
                )}
              </div>
            )}
            {attempts.length > 1 && (
              <details className="mt-2"><summary className="cursor-pointer text-[12px]">Discovery history ({attempts.length})</summary>
                <ul className="mt-1 text-[12px]">{attempts.map((a) => <li key={a.id}>{fmtDate(a.attemptedAt ?? a.createdAt, zone)} — {a.kind} via {a.provider}: {a.status}{a.outcome ? ` / ${a.outcome}` : ""}{a.creditsActual ? ` · ${a.creditsActual} credits (actual)` : a.creditsEstimated ? ` · ~${a.creditsEstimated} credits (estimate)` : ""}{a.errorMessage ? ` — ${a.errorMessage}` : ""}</li>)}</ul>
              </details>
            )}
          </Section>

          <Section title="Opportunities">
            {opps.map((o) => (
              <form key={o.id} action={upsertOpportunityAction} className="mb-2 flex flex-wrap items-end gap-2 border-b border-line pb-2">
                <input type="hidden" name="companyId" value={c.id} /><input type="hidden" name="id" value={o.id} />
                <Field label="Role" htmlFor={`r-${o.id}`}><input id={`r-${o.id}`} name="roleTitle" defaultValue={o.roleTitle} className="w-64" /></Field>
                <Field label="Stage" htmlFor={`s-${o.id}`}><select id={`s-${o.id}`} name="stage" defaultValue={o.stage}>{STAGES.map((x) => <option key={x}>{x}</option>)}</select></Field>
                <Field label="Season" htmlFor={`se-${o.id}`}><input id={`se-${o.id}`} name="season" defaultValue={o.season ?? ""} placeholder="Unknown" className="w-28" /></Field>
                <Field label="Deadline" htmlFor={`d-${o.id}`}><input id={`d-${o.id}`} name="deadline" defaultValue={o.deadline ?? ""} placeholder="Unknown" className="w-28" /></Field>
                <Field label="Visa / sponsorship" htmlFor={`v-${o.id}`}><input id={`v-${o.id}`} name="visaInfo" defaultValue={o.visaInfo ?? ""} placeholder="Unknown" className="w-40" /></Field>
                <Field label="Language" htmlFor={`l-${o.id}`}><input id={`l-${o.id}`} name="workingLanguage" defaultValue={o.workingLanguage ?? ""} placeholder="Unknown" className="w-24" /></Field>
                <Button type="submit">Save</Button>
              </form>
            ))}
            <form action={upsertOpportunityAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="companyId" value={c.id} />
              <Field label="New opportunity role" htmlFor="no-r"><input id="no-r" name="roleTitle" placeholder="Mechanical engineering intern" className="w-64" /></Field>
              <Field label="URL" htmlFor="no-u"><input id="no-u" name="url" type="url" defaultValue={c.opportunityUrl ?? ""} /></Field>
              <Button type="submit">Add</Button>
            </form>
            <p className="mt-1 text-[11px] text-muted">Moving to interview/offer/rejected/withdrawn/closed pauses pending follow-ups for this company.</p>
          </Section>

          <Section title="Activity timeline">
            {timeline.length === 0 ? <p className="text-[13px] text-muted">No activity yet.</p> : (
              <ol className="text-[13px]">{timeline.map((t, i) => <li key={i} className="border-b border-line py-1"><span className="mr-2 text-muted tabular-nums">{fmtDate(t.at, zone)}</span>{t.href ? <Link href={t.href}>{t.text}</Link> : t.text}</li>)}</ol>
            )}
          </Section>
        </div>

        <div className="flex flex-col gap-3">
          <Section title="Status">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-muted">Email</dt><dd>{summary.emailAvailability === "missing" ? "Missing" : <QualityBadge quality={summary.bestQuality ?? "unknown"} />}</dd>
              <dt className="text-muted">Discovery</dt><dd>{c.discoveryStatus.replace(/_/g, " ")}</dd>
              <dt className="text-muted">Imported status</dt><dd title="Historical text from your workbook — not provider evidence">{c.importedOutreachStatus ?? "—"}</dd>
              <dt className="text-muted">Internship evidence</dt><dd>{c.internshipEvidence ?? "Unknown"}</dd>
              <dt className="text-muted">Eligibility</dt><dd>{c.eligibilityStatus ?? "Unknown"}</dd>
              <dt className="text-muted">Size</dt><dd>{c.sizeText ?? "Unknown"}</dd>
              <dt className="text-muted">Founded</dt><dd>{c.foundedText ?? "Unknown"}</dd>
            </dl>
            <div className="mt-2 flex flex-wrap gap-2">
              <form action={suppressCompanyAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="on" value={c.suppressed ? "0" : "1"} /><Button variant={c.suppressed ? "secondary" : "danger"} type="submit">{c.suppressed ? "Remove suppression" : "Suppress further outreach"}</Button></form>
              <form action={closeCompanyAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="on" value={c.outreachClosed ? "0" : "1"} /><Button type="submit">{c.outreachClosed ? "Reopen" : "Mark closed"}</Button></form>
            </div>
          </Section>

          <Section title="Profile & research">
            <form action={updateCompanyAction} className="flex flex-col gap-2">
              <input type="hidden" name="id" value={c.id} />
              <Field label="Priority" htmlFor="p-pr"><select id="p-pr" name="priority" defaultValue={c.priority}>{["primary", "reserve", "lead", "other"].map((x) => <option key={x}>{x}</option>)}</select></Field>
              <Field label="Industry" htmlFor="p-in"><input id="p-in" name="industryPrimary" defaultValue={c.industryPrimary ?? ""} /></Field>
              <Field label="Website" htmlFor="p-web"><input id="p-web" name="website" defaultValue={c.website ?? ""} /></Field>
              <Field label="Next action" htmlFor="p-na"><input id="p-na" name="nextAction" defaultValue={c.nextAction ?? ""} /></Field>
              <Field label="Next action due" htmlFor="p-nd"><input id="p-nd" name="nextActionDue" type="date" defaultValue={c.nextActionDue ? c.nextActionDue.toISOString().slice(0, 10) : ""} /></Field>
              <Field label="Notes" htmlFor="p-no"><textarea id="p-no" name="notes" rows={3} defaultValue={c.notes ?? ""} /></Field>
              <Field label="Research notes" htmlFor="p-rn"><textarea id="p-rn" name="researchNotes" rows={3} defaultValue={c.researchNotes ?? ""} /></Field>
              <Button type="submit">Save profile</Button>
            </form>
            {c.description && <p className="mt-2 text-[13px]">{c.description}</p>}
            {c.engineeringActivity && <p className="mt-1 text-[13px]"><span className="text-muted">Engineering: </span>{c.engineeringActivity}</p>}
            {c.potentialInternWork && <p className="mt-1 text-[13px]"><span className="text-muted">Intern work: </span>{c.potentialInternWork}</p>}
            {c.careersUrl && <p className="mt-1 text-[13px]"><a href={c.careersUrl} target="_blank" rel="noopener noreferrer">Careers page</a></p>}
          </Section>

          <Section title="Location & business timezone">
            {locations.length === 0 && <p className="text-[13px] text-muted">No location recorded.</p>}
            {locations.map((l) => (
              <div key={l.id} className="mb-2 text-[13px]">
                <div>{l.label ?? ([l.city, l.country].filter(Boolean).join(", ") || "—")} <Badge>{l.kind}</Badge></div>
                <div className="text-[12px] text-muted">
                  {l.lat != null ? `${l.lat.toFixed(3)}, ${l.lng!.toFixed(3)}` : "no coordinates"} · {l.geocodeStatus}{l.precision === "country" ? " · approximate (country-level pin)" : l.precision === "city" ? " · city-level" : ""}{l.geocodeProvider ? ` · ${l.geocodeProvider}` : ""}
                </div>
                <div className="text-[12px]">Timezone: {l.timezone ?? <span className="text-warn">unknown — {tzSug.explanation}</span>}</div>
              </div>
            ))}
            {c.engineeringLocation && <p className="text-[12px] text-muted">Engineering site: {c.engineeringLocation}</p>}
            <details className="mt-1"><summary className="cursor-pointer text-[12px]">Correct location / timezone</summary>
              <form action={setLocationAction} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="companyId" value={c.id} />
                {primaryLoc && <input type="hidden" name="locationId" value={primaryLoc.id} />}
                <Field label="Latitude" htmlFor="lat"><input id="lat" name="lat" type="number" step="any" required className="w-28" defaultValue={primaryLoc?.lat ?? ""} /></Field>
                <Field label="Longitude" htmlFor="lng"><input id="lng" name="lng" type="number" step="any" required className="w-28" defaultValue={primaryLoc?.lng ?? ""} /></Field>
                <Button type="submit">Save coordinates</Button>
              </form>
              <form action={setTimezoneAction} className="mt-2 flex items-end gap-2">
                <input type="hidden" name="companyId" value={c.id} />
                <Field label="IANA timezone" htmlFor="tz"><input id="tz" name="timezone" list="tz-cands" defaultValue={primaryLoc?.timezone ?? tzSug.zone ?? ""} placeholder="Europe/Berlin" /></Field>
                <datalist id="tz-cands">{tzSug.candidates.map((z) => <option key={z} value={z} />)}</datalist>
                <Button type="submit">Set timezone</Button>
              </form>
            </details>
          </Section>

          <Section title="Reminders">
            {tasks.map((t) => <div key={t.id} className="text-[13px]">• {t.title} <span className="text-muted">{t.dueAt ? fmtDate(t.dueAt, zone, false) : ""}</span></div>)}
            <form action={addReminderAction} className="mt-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="companyId" value={c.id} />
              <Field label="Reminder" htmlFor="rm-t"><input id="rm-t" name="title" placeholder="Contact again in February" required /></Field>
              <Field label="Due" htmlFor="rm-d"><input id="rm-d" name="dueAt" type="date" /></Field>
              <Button type="submit">Add</Button>
            </form>
          </Section>

          <Section title={`Messages (${msgs.length})`}>
            {msgs.length === 0 ? <p className="text-[13px] text-muted">None.</p> : msgs.slice(0, 15).map((m) => (
              <div key={m.id} className="mb-1 text-[13px]">
                <StateBadge state={m.status} /> <Link href={m.direction === "inbound" && m.conversationId ? `/inbox/${m.conversationId}` : `/drafts/${m.id}`}>{m.subject ?? "(no subject)"}</Link>
                {m.isBounce && <Badge tone="danger">bounced</Badge>}
                <div className="text-[11px] text-muted">{m.direction} · {m.evidenceSource.replace(/_/g, " ")} · {fmtDate(m.receivedAt ?? m.recordedSentAt ?? m.createdAt, zone)}</div>
              </div>
            ))}
          </Section>

          <Section title={`Source evidence (${evidence.length})`}>
            {evidence.length === 0 ? <p className="text-[13px] text-muted">No evidence rows.</p> : (
              <ul className="text-[12px]">{evidence.slice(0, 20).map((e) => <li key={e.id} className="mb-1">{e.fieldSupported && <Badge>{e.fieldSupported}</Badge>} {e.summary} {e.url && <a href={e.url} target="_blank" rel="noopener noreferrer">source</a>} <span className="text-muted">{e.accessedDate}</span>{e.source === "ai_suggestion" && <Badge tone="warn">AI — unreviewed</Badge>}</li>)}</ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
