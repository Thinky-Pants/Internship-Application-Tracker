import Link from "next/link";
import { eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { encryptionConfigured } from "@/lib/crypto";
import { graphAuthConfig, GRAPH_SCOPES } from "@/providers/mail/graph-auth";
import { geocoderConfig } from "@/domain/geo/geocode";
import { webhooksEnabled } from "@/domain/mail/subscriptions";
import { DEFAULT_ROLE_HEURISTICS } from "@/domain/discovery/service";
import { DEFAULT_ANTHROPIC_MODEL } from "@/providers/ai/anthropic";
import { isDemoMode } from "@/server/runtime";
import { mapStyle } from "@/server/map-config";
import { Badge, Button, Field, fmtDate, LinkButton, Notice, PageHeader, Section } from "@/components/ui";
import { Flash } from "@/components/flash";
import { setThemeAction } from "@/app/actions/auth";
import {
  savePreferencesAction, saveMailboxLimitsAction, toggleFolderAction, refreshFoldersAction, disconnectMailboxAction, addMockMailboxAction, reconnectMockAction,
  saveProviderKeyAction, removeProviderKeyAction, testApolloAction, saveMapConfigAction, saveHeuristicsAction, advanceDemoClockAction,
} from "@/app/actions/settings";

export const metadata = { title: "Settings & Integrations" };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = { connected: "ok", expired: "danger", restricted: "warn", disconnected: "neutral", unconfigured: "neutral", error: "danger" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const db = getDb();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const mailboxes = await db.select().from(s.mailboxes).where(eq(s.mailboxes.ownerId, owner.id));
  const folders = await db.select().from(s.mailboxFolders);
  const creds = await db.select().from(s.providerCredentials).where(eq(s.providerCredentials.ownerId, owner.id));
  const cred = (p: string) => creds.find((c) => c.provider === p);
  const win = st.sendingWindow as { days: number[]; start: string; end: string };
  const msCfg = graphAuthConfig();
  const geo = geocoderConfig();
  const map = mapStyle(st);
  return (
    <>
      <PageHeader title="Settings & Integrations" subtitle="Optional connections can be skipped; the app works with CSV/manual workflows and mock providers." />
      <Flash sp={sp} />
      {sp.setup && <div className="mb-3"><Notice title="First-run setup">1) Set your display timezone and sending window below. 2) <Link href="/imports">Import your workbook</Link>. 3) Map/geocoding (optional). 4) Apollo / AI keys (optional). 5) Connect Outlook (or add a mock mailbox for practice). 6) <Link href="/library">Upload CVs</Link> and fill in your verified profile.</Notice></div>}
      {!encryptionConfigured() && <div className="mb-3"><Notice tone="danger" title="APP_ENCRYPTION_KEY is not set">Provider keys and mailbox tokens cannot be stored until you set a 32-byte base64 key in the environment (see .env.example).</Notice></div>}

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Preferences & sending window">
          <form action={savePreferencesAction} className="flex flex-col gap-2">
            <Field label="Display timezone (IANA)" htmlFor="pr-tz" hint="Default Asia/Riyadh. All times in the app are shown in this zone plus the schedule's own zone."><input id="pr-tz" name="displayTimezone" defaultValue={st.displayTimezone} /></Field>
            <fieldset><legend className="text-[12px] text-muted">Allowed sending days (evaluated in each schedule's timezone)</legend>
              <div className="flex flex-wrap gap-2">{DAYS.map((d, i) => <label key={d} className="flex items-center gap-1 text-[13px] text-fg"><input type="checkbox" name="days" value={i + 1} defaultChecked={win.days.includes(i + 1)} />{d}</label>)}</div></fieldset>
            <div className="flex gap-2"><Field label="Window start" htmlFor="pr-s"><input id="pr-s" name="start" type="time" defaultValue={win.start} /></Field><Field label="Window end" htmlFor="pr-e"><input id="pr-e" name="end" type="time" defaultValue={win.end} /></Field></div>
            <p className="text-[11px] text-muted">Holidays are not considered (no holiday calendar source is configured).</p>
            <Field label="Missed-send grace window (minutes)" htmlFor="pr-g" hint="Overdue sends younger than this are spread through limits; older ones are held for review."><input id="pr-g" name="grace" type="number" min={5} defaultValue={st.missedSendGraceMinutes} /></Field>
            <Field label="When one contact replies" htmlFor="pr-p"><select id="pr-p" name="policy" defaultValue={st.companyCoordinationPolicy}><option value="pause_company">Pause pending sends to everyone at that company</option><option value="pause_contact_only">Pause only that contact</option></select></Field>
            <Field label="Hold follow-ups if mailbox sync is older than (minutes)" htmlFor="pr-sa"><input id="pr-sa" name="syncAge" type="number" min={5} defaultValue={st.followupMaxSyncAgeMinutes} /></Field>
            <label className="flex items-center gap-1 text-[13px] text-fg"><input type="checkbox" name="keepApproval" value="1" defaultChecked={st.keepApprovalOnReschedule} /> Keep approval when only the time changes</label>
            <Button variant="primary" type="submit">Save preferences</Button>
          </form>
          <form action={setThemeAction} className="mt-3 flex items-center gap-2"><input type="hidden" name="back" value="/settings" /><label htmlFor="theme">Theme</label><select id="theme" name="theme" defaultValue=""><option value="">System</option><option value="light">Light</option><option value="dark">Dark</option></select><Button type="submit">Apply</Button></form>
        </Section>

        <Section title={<span id="mailboxes">Outlook mailboxes</span>}>
          <p className="mb-2 text-[12px] text-muted">Delegated Microsoft Graph sign-in; scopes requested: <code>{GRAPH_SCOPES.join(" ")}</code>. This app never asks for your mailbox password. A university/work tenant may block consent; the app shows that as “restricted” and keeps your schedules. Sync mode: {webhooksEnabled() ? "webhooks (cloud) + safety polling" : "polling (local/no public HTTPS URL)"}.</p>
          {msCfg ? <LinkButton variant="primary" href="/api/oauth/microsoft/start">Connect Outlook account</LinkButton> : <Notice tone="warn" title="Microsoft app registration not configured">Set MS_CLIENT_ID, MS_CLIENT_SECRET and MS_REDIRECT_URI (see docs/OUTLOOK.md). Until then you can practise with a mock mailbox.</Notice>}
          {(isDemoMode() || process.env.NODE_ENV !== "production") && <form action={addMockMailboxAction} className="mt-2"><Button type="submit">Add mock mailbox (never sends)</Button></form>}
          {mailboxes.map((m) => (
            <div key={m.id} className="mt-3 rounded-md border border-line p-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2"><strong>{m.emailAddress ?? "(unnamed)"}</strong><Badge>{m.provider}</Badge><Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Badge>{m.isDemo && <Badge tone="purple">mock</Badge>}</div>
              {m.statusReason && <p className="text-[12px] text-muted">{m.statusReason}</p>}
              <p className="text-[12px] text-muted">Last sync {m.lastSyncAt ? fmtDate(m.lastSyncAt, st.displayTimezone) : "never"}{m.lastSyncError ? ` — error: ${m.lastSyncError}` : ""} · token expires {m.tokenExpiresAt ? fmtDate(m.tokenExpiresAt, st.displayTimezone) : "—"}</p>
              <form action={saveMailboxLimitsAction} className="mt-1 flex flex-wrap items-end gap-2">
                <input type="hidden" name="mailboxId" value={m.id} />
                <Field label="Per day" htmlFor={`d-${m.id}`}><input id={`d-${m.id}`} name="daily" type="number" defaultValue={m.dailyLimit} className="w-20" /></Field>
                <Field label="Per hour" htmlFor={`h-${m.id}`}><input id={`h-${m.id}`} name="hourly" type="number" defaultValue={m.hourlyLimit} className="w-20" /></Field>
                <Field label="Min spacing (s)" htmlFor={`sp-${m.id}`}><input id={`sp-${m.id}`} name="spacing" type="number" defaultValue={m.minSpacingSeconds} className="w-24" /></Field>
                <Field label="Initial sync (days)" htmlFor={`sd-${m.id}`}><input id={`sd-${m.id}`} name="syncDays" type="number" defaultValue={m.initialSyncDays} className="w-20" /></Field>
                <Button type="submit">Save limits</Button>
              </form>
              <details className="mt-1"><summary className="cursor-pointer text-[12px]">Folders & coverage</summary>
                <ul className="text-[12px]">{folders.filter((f) => f.mailboxId === m.id).map((f) => (
                  <li key={f.id} className="flex items-center gap-2"><form action={toggleFolderAction}><input type="hidden" name="folderId" value={f.id} /><input type="hidden" name="on" value={f.tracked ? "0" : "1"} /><Button type="submit">{f.tracked ? "Stop tracking" : "Track"}</Button></form>{f.displayName} <span className="text-muted">({f.role}, {f.messageCount} items) {f.tracked ? `· last synced ${f.lastSyncedAt ? fmtDate(f.lastSyncedAt, st.displayTimezone) : "never"}` : "· not tracked"}{f.lastError ? ` · ${f.lastError}` : ""}</span></li>
                ))}</ul>
                <form action={refreshFoldersAction}><input type="hidden" name="mailboxId" value={m.id} /><Button type="submit">Discover folders & sync</Button></form>
                <p className="text-[11px] text-muted">Track any folder your mail rules move replies into; otherwise replies there are invisible to the app.</p>
              </details>
              <div className="mt-2 flex gap-2">
                {m.status !== "disconnected" && <form action={disconnectMailboxAction}><input type="hidden" name="mailboxId" value={m.id} /><Button variant="danger" type="submit">Disconnect</Button></form>}
                {m.provider === "mock" && m.status !== "connected" && <form action={reconnectMockAction}><input type="hidden" name="mailboxId" value={m.id} /><Button type="submit">Reconnect mock</Button></form>}
                {m.provider === "graph" && m.status !== "connected" && msCfg && <LinkButton href="/api/oauth/microsoft/start">Reconnect</LinkButton>}
              </div>
            </div>
          ))}
        </Section>

        <Section title={<span id="integrations">Apollo (contact discovery)</span>}>
          <ProviderStatus c={cred("apollo")} />
          <p className="mb-2 text-[12px] text-muted">People search (0 credits per Apollo docs) and enrichment (credits charged when data is returned) are separate. Some endpoints need a master API key or key scope. Free accounts may need a work email for some actions. The CSV import works without an API key.</p>
          <form action={saveProviderKeyAction} className="flex flex-col gap-2">
            <input type="hidden" name="provider" value="apollo" />
            <Field label="API key (stored encrypted)" htmlFor="ap-k"><input id="ap-k" name="apiKey" type="password" autoComplete="off" placeholder={cred("apollo")?.secretEnc ? "•••••••• (stored)" : ""} /></Field>
            <Field label="Default credit budget per enrichment run" htmlFor="ap-b"><input id="ap-b" name="creditBudget" type="number" min={0} defaultValue={(cred("apollo")?.config as { creditBudget?: number })?.creditBudget ?? 10} /></Field>
            <div className="flex gap-2"><Button type="submit">Save</Button></div>
          </form>
          {cred("apollo")?.secretEnc && <div className="mt-2 flex gap-2"><form action={testApolloAction} className="flex gap-1"><input name="domain" placeholder="test domain e.g. apollo.io" aria-label="Test domain" /><Button type="submit">Test (1 search request)</Button></form><form action={removeProviderKeyAction}><input type="hidden" name="provider" value="apollo" /><Button variant="danger" type="submit">Remove key</Button></form></div>}
        </Section>

        <Section title="AI providers (optional)">
          <p className="mb-2 text-[12px] text-muted">API accounts and billing are separate from Claude.ai / ChatGPT subscriptions — a chat subscription does not include API credits. The manual exchange (Imports & Exports → AI exchange) works without any key. AI only creates suggestions.</p>
          {(["anthropic", "openai"] as const).map((p) => (
            <form key={p} action={saveProviderKeyAction} className="mb-3 flex flex-col gap-2 border-b border-line pb-2">
              <input type="hidden" name="provider" value={p} />
              <div className="flex items-center gap-2"><strong className="text-[13px]">{p === "anthropic" ? "Anthropic (Claude)" : "OpenAI"}</strong><ProviderStatus c={cred(p)} inline /></div>
              <Field label="API key" htmlFor={`k-${p}`}><input id={`k-${p}`} name="apiKey" type="password" autoComplete="off" placeholder={cred(p)?.secretEnc ? "•••••••• (stored)" : ""} /></Field>
              <Field label="Model" htmlFor={`m-${p}`} hint={p === "anthropic" ? `Default ${DEFAULT_ANTHROPIC_MODEL}; check current models in the provider docs.` : "Required — enter a current model ID from the OpenAI docs."}><input id={`m-${p}`} name="model" defaultValue={(cred(p)?.config as { model?: string })?.model ?? ""} /></Field>
              <Field label="Monthly token budget (0 = no limit)" htmlFor={`b-${p}`}><input id={`b-${p}`} name="budget" type="number" min={0} defaultValue={(cred(p)?.config as { monthlyTokenBudget?: number })?.monthlyTokenBudget ?? 200000} /></Field>
              <div className="flex gap-2"><Button type="submit">Save</Button></div>
            </form>
          ))}
        </Section>

        <Section title={<span id="map">Map tiles & geocoding</span>}>
          <form action={saveMapConfigAction} className="flex flex-col gap-2">
            <Field label="MapLibre style URL" htmlFor="mp-u" hint="Any supported vector style (OpenFreeMap, MapTiler, Stadia, self-hosted). Respect the provider's terms."><input id="mp-u" name="styleUrl" defaultValue={map.styleUrl} /></Field>
            <Field label="Attribution (shown on the map)" htmlFor="mp-a"><input id="mp-a" name="attribution" defaultValue={map.attribution} /></Field>
            <Button type="submit">Save map settings</Button>
          </form>
          <p className="mt-2 text-[12px]">Geocoder: <strong>{geo.provider}</strong>{geo.provider === "nominatim" ? ` (${geo.url}, ≥${geo.minIntervalMs} ms between requests)` : " — only approximate country-level pins until GEOCODER is configured"}. Set via environment (GEOCODER, GEOCODER_URL, GEOCODER_USER_AGENT). Public Nominatim allows at most 1 request/second and requires attribution; use your own instance or a commercial provider for bulk work.</p>
        </Section>

        <Section title={<span id="heuristics">Contact-role heuristics</span>}>
          <form action={saveHeuristicsAction} className="flex flex-col gap-2">
            <Field label="JSON (editable suggestions — a title does not guarantee hiring authority)" htmlFor="hj"><textarea id="hj" name="json" rows={10} className="font-mono text-[11px]" defaultValue={JSON.stringify({ ...DEFAULT_ROLE_HEURISTICS, ...(st.roleHeuristics as object) }, null, 2)} /></Field>
            <Button type="submit">Save heuristics</Button>
          </form>
        </Section>

        {isDemoMode() && (
          <Section title={<span id="demo">Demo: simulated time</span>}>
            <p className="mb-2 text-[12px] text-muted">Advance the shared clock to watch scheduled sends dispatch, follow-ups come due and reconciliation happen. Restart the worker at any time to see that nothing is lost.</p>
            <form action={advanceDemoClockAction} className="flex gap-2">
              <select name="hours" aria-label="Advance by"><option value="1">+1 hour</option><option value="6">+6 hours</option><option value="24">+1 day</option><option value="72">+3 days</option><option value="168">+1 week</option></select>
              <Button type="submit">Advance</Button>
            </form>
            <form action={advanceDemoClockAction} className="mt-1"><input type="hidden" name="reset" value="1" /><Button type="submit">Reset to real time</Button></form>
          </Section>
        )}
      </div>
    </>
  );
}

function ProviderStatus({ c, inline }: { c?: typeof s.providerCredentials.$inferSelect; inline?: boolean }) {
  const status = c?.secretEnc ? c.status : "unconfigured";
  const el = <><Badge tone={STATUS_TONE[status] ?? "neutral"}>{status}</Badge>{c?.statusReason && <span className="ml-1 text-[12px] text-muted">{c.statusReason}</span>}</>;
  return inline ? el : <div className="mb-2">{el}</div>;
}
