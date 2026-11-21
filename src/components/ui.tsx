/** Small accessible UI kit (server-safe; no client state). */
import Link from "next/link";
import type { ReactNode } from "react";
import type { OutreachProgress } from "@/domain/summary";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, children, actions, className }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          {title && <h2 className="text-[13px] font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg border-accent hover:opacity-90",
  secondary: "bg-surface text-fg border-line hover:bg-surface-2",
  danger: "bg-surface text-danger border-danger/60 hover:bg-surface-2",
  ghost: "bg-transparent text-fg border-transparent hover:bg-surface-2",
};

export function Button({ children, variant = "secondary", className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button {...rest} className={cx("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50", VARIANT[variant], className)}>
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "secondary", className }: { href: string; children: ReactNode; variant?: Variant; className?: string }) {
  return (
    <Link href={href} className={cx("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] font-medium no-underline hover:no-underline", VARIANT[variant], className)}>
      {children}
    </Link>
  );
}

type Tone = "neutral" | "info" | "ok" | "warn" | "danger" | "purple";
const TONE: Record<Tone, string> = {
  neutral: "border-line text-muted",
  info: "border-[var(--st-blue)] text-[var(--st-blue)]",
  ok: "border-[var(--st-green)] text-[var(--st-green)]",
  warn: "border-[var(--st-yellow)] text-[var(--warn)]",
  danger: "border-[var(--st-red)] text-[var(--danger)]",
  purple: "border-[var(--st-purple)] text-[var(--st-purple)]",
};

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px text-[11px] font-medium", TONE[tone])}>
      {children}
    </span>
  );
}

/** Outreach progress: colour + glyph + text, so meaning never depends on colour alone. */
export const PROGRESS_STYLE: Record<OutreachProgress, { tone: Tone; glyph: string; label: string; color: string; shape: string }> = {
  not_contacted: { tone: "neutral", glyph: "○", label: "Not contacted", color: "var(--st-gray)", shape: "circle" },
  drafting: { tone: "neutral", glyph: "✎", label: "Drafting", color: "var(--st-gray)", shape: "circle" },
  ready: { tone: "info", glyph: "◆", label: "Ready", color: "var(--st-blue)", shape: "diamond" },
  scheduled: { tone: "info", glyph: "◷", label: "Scheduled", color: "var(--st-blue)", shape: "diamond" },
  contacted: { tone: "warn", glyph: "✉", label: "Awaiting reply", color: "var(--st-yellow)", shape: "square" },
  replied: { tone: "purple", glyph: "↩", label: "Replied", color: "var(--st-purple)", shape: "triangle" },
  interviewing: { tone: "ok", glyph: "★", label: "Interview / offer", color: "var(--st-green)", shape: "star" },
  closed: { tone: "danger", glyph: "✕", label: "Closed", color: "var(--st-red)", shape: "cross" },
};

export function ProgressBadge({ p }: { p: OutreachProgress }) {
  const st = PROGRESS_STYLE[p];
  return (
    <Badge tone={st.tone}>
      <span aria-hidden>{st.glyph}</span>
      {st.label}
    </Badge>
  );
}

export const QUALITY_LABEL: Record<string, { label: string; tone: Tone; help: string }> = {
  provider_verified: { label: "Provider-verified", tone: "ok", help: "The provider reported this address as verified. That is not a delivery guarantee." },
  catch_all: { label: "Catch-all", tone: "warn", help: "The domain accepts all addresses, so the provider cannot confirm this mailbox exists." },
  unknown: { label: "Unverified", tone: "neutral", help: "No provider verification (e.g. manual, website, CSV 'unverified'/'extrapolated', or AI-guessed)." },
  invalid: { label: "Invalid", tone: "danger", help: "Marked invalid or bounced; it will not be used." },
};

export function QualityBadge({ quality, bounce }: { quality: string; bounce?: string }) {
  if (bounce === "hard") return <Badge tone="danger" title="A delivery failure was received for this address.">✕ Bounced</Badge>;
  const q = QUALITY_LABEL[quality] ?? QUALITY_LABEL.unknown;
  return <Badge tone={q.tone} title={q.help}>{q.label}</Badge>;
}

export const SEND_TONE: Record<string, Tone> = {
  scheduled: "info", held: "warn", paused: "warn", dispatching: "info", submitted: "purple", recorded_sent: "ok", uncertain: "danger", failed: "danger", cancelled: "neutral", superseded: "neutral",
  draft: "neutral", awaiting_approval: "warn", approved: "info", received: "neutral",
};

export function StateBadge({ state }: { state: string }) {
  return <Badge tone={SEND_TONE[state] ?? "neutral"}>{state.replace(/_/g, " ")}</Badge>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-6 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function Notice({ tone = "info", children, title }: { tone?: "info" | "warn" | "danger" | "ok"; children: ReactNode; title?: string }) {
  const c = { info: "border-[var(--st-blue)]", warn: "border-[var(--st-yellow)]", danger: "border-[var(--st-red)]", ok: "border-[var(--st-green)]" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("rounded-md border-l-4 bg-surface px-3 py-2 text-[13px]", c)}>
      {title && <p className="font-semibold">{title}</p>}
      <div className="text-fg">{children}</div>
    </div>
  );
}

export function Stat({ label, value, href, hint }: { label: string; value: ReactNode; href?: string; hint?: string }) {
  const inner = (
    <div className="min-w-[120px] rounded-md border border-line bg-surface px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
  return href ? <Link href={href} className="no-underline hover:no-underline text-fg">{inner}</Link> : inner;
}

export function Field({ label, children, hint, htmlFor }: { label: string; children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

export function fmtDate(d: Date | string | null | undefined, zone = "UTC", withTime = true) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "2-digit", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) }).format(new Date(d));
}
