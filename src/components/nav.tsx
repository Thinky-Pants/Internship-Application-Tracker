"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export const NAV = [
  { href: "/", label: "Today", carry: false },
  { href: "/map", label: "World Map", carry: true },
  { href: "/companies", label: "Companies", carry: true },
  { href: "/contacts", label: "Contacts & Discovery", carry: true },
  { href: "/pipeline", label: "Pipeline", carry: true },
  { href: "/drafts", label: "Drafts & Review", carry: false },
  { href: "/schedule", label: "Schedule & Queue", carry: false },
  { href: "/inbox", label: "Inbox", carry: false },
  { href: "/library", label: "CVs & Templates", carry: false },
  { href: "/imports", label: "Imports & Exports", carry: false },
  { href: "/analytics", label: "Analytics", carry: false },
  { href: "/settings", label: "Settings & Integrations", carry: false },
];

const FILTER_KEYS = ["q", "priority", "industry", "region", "country", "email", "quality", "progress", "discovery", "stage", "role", "activity", "followup"];

export function NavLinks({ compact = false }: { compact?: boolean }) {
  const path = usePathname();
  const sp = useSearchParams();
  // Company filters carry across the company-oriented views.
  const carried = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = sp.get(k);
    if (v) carried.set(k, v);
  }
  const qs = carried.toString();
  return (
    <ul className={compact ? "flex gap-1 whitespace-nowrap" : "flex flex-col gap-px px-2"}>
      {NAV.map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
        const href = n.carry && qs ? `${n.href}?${qs}` : n.href;
        return (
          <li key={n.href}>
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={`block rounded-md px-2 py-1.5 text-[13px] no-underline hover:no-underline ${active ? "bg-surface-2 font-semibold text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
            >
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
