/**
 * Normalisation helpers for imported data: domains, emails, countries, lists.
 * Pure functions — unit tested in tests/normalize.test.ts.
 */

const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.cn", "net.cn", "org.cn", "com.tw", "org.tw", "co.jp", "or.jp", "ne.jp",
  "co.kr", "or.kr", "com.au", "net.au", "org.au", "co.nz", "com.my", "com.sg", "com.hk", "co.id", "co.in", "com.mx",
  "com.tr", "com.br", "co.za", "com.pl", "com.es", "com.pt",
]);

/** Host from a URL or bare domain; lower-case, no "www.", no port/path. Returns null if invalid. */
export function normalizeHost(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s || s === "unknown" || s === "n/a" || s === "-") return null;
  s = s.replace(/^mailto:/, "");
  if (s.includes("@") && !s.includes("/")) s = s.split("@").pop()!;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "http://" + s;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\d?\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host) && !/^xn--/.test(host)) return null;
  return host;
}

/** Registrable domain (eTLD+1, using a small known multi-part suffix list). */
export function registrableDomain(host: string | null): string | null {
  if (!host) return null;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

export function normalizeDomain(input: string | null | undefined): string | null {
  return normalizeHost(input);
}

export function normalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s || /^unknown$/i.test(s)) return null;
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s;
  try {
    const u = new URL(withProto);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Normalised email (trim, strip mailto/angle brackets, lower-case). Null if syntactically invalid. */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  const angle = s.match(/<([^>]+)>/);
  if (angle) s = angle[1];
  s = s.replace(/^mailto:/i, "").trim().toLowerCase();
  if (s.length > 254 || !EMAIL_RE.test(s)) return null;
  return s;
}

const GENERAL_LOCALPARTS = new Set([
  "info", "contact", "hello", "office", "mail", "careers", "career", "jobs", "hr", "recruiting", "recruitment", "talent",
  "admin", "support", "sales", "team", "general", "enquiries", "inquiries", "kontakt", "post", "service",
]);

export function classifyEmailKind(normalized: string): "named" | "general" | "other" {
  const local = normalized.split("@")[0];
  if (GENERAL_LOCALPARTS.has(local) || GENERAL_LOCALPARTS.has(local.replace(/[^a-z]/g, ""))) return "general";
  if (/^(no-?reply|do-?not-?reply|bounce|mailer-daemon|postmaster)/.test(local)) return "other";
  return "named";
}

/** Split list-like cells: "a; b, c | d" → ["a","b","c","d"]. */
export function splitList(input: string | null | undefined): string[] {
  if (!input) return [];
  return String(input)
    .split(/[;,|\n]+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^unknown$/i.test(s));
}

export function cleanText(input: unknown): string | null {
  if (input == null) return null;
  const s = String(input).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s;
}

/** Treat the literal "Unknown" as absent for typed fields, but keep it in source_row. */
export function cleanKnown(input: unknown): string | null {
  const s = cleanText(input);
  if (!s || /^(unknown|n\/a|na|none|-|—)$/i.test(s)) return null;
  return s;
}

export function parseIntSafe(input: unknown): number | null {
  const s = cleanText(input);
  if (!s) return null;
  const n = Number(s.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ───────────────────────── Countries ─────────────────────────
export interface CountryInfo {
  code: string;
  name: string;
  /** Approximate centroid for country-level (approximate) pins. */
  lat: number;
  lng: number;
  /** Single IANA zone when unambiguous; null when the country spans several zones. */
  timezone: string | null;
  /** Candidate zones (for multi-zone countries the user must pick). */
  zones: string[];
  aliases?: string[];
}

export const COUNTRIES: CountryInfo[] = [
  { code: "US", name: "United States", lat: 39.8, lng: -98.6, timezone: null, zones: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"], aliases: ["usa", "u.s.", "u.s.a.", "united states of america", "us", "america"] },
  { code: "CA", name: "Canada", lat: 56.1, lng: -106.3, timezone: null, zones: ["America/Toronto", "America/Vancouver", "America/Edmonton", "America/Halifax", "America/Winnipeg"] },
  { code: "MX", name: "Mexico", lat: 23.6, lng: -102.5, timezone: null, zones: ["America/Mexico_City", "America/Tijuana", "America/Monterrey"] },
  { code: "GB", name: "United Kingdom", lat: 54.0, lng: -2.5, timezone: "Europe/London", zones: ["Europe/London"], aliases: ["uk", "u.k.", "great britain", "britain", "england", "scotland", "wales"] },
  { code: "IE", name: "Ireland", lat: 53.4, lng: -8.2, timezone: "Europe/Dublin", zones: ["Europe/Dublin"] },
  { code: "DE", name: "Germany", lat: 51.2, lng: 10.4, timezone: "Europe/Berlin", zones: ["Europe/Berlin"], aliases: ["deutschland"] },
  { code: "FR", name: "France", lat: 46.6, lng: 2.2, timezone: "Europe/Paris", zones: ["Europe/Paris"] },
  { code: "IT", name: "Italy", lat: 42.8, lng: 12.6, timezone: "Europe/Rome", zones: ["Europe/Rome"], aliases: ["italia"] },
  { code: "ES", name: "Spain", lat: 40.4, lng: -3.7, timezone: "Europe/Madrid", zones: ["Europe/Madrid"], aliases: ["españa", "espana"] },
  { code: "PT", name: "Portugal", lat: 39.6, lng: -8.0, timezone: "Europe/Lisbon", zones: ["Europe/Lisbon"] },
  { code: "NL", name: "Netherlands", lat: 52.2, lng: 5.3, timezone: "Europe/Amsterdam", zones: ["Europe/Amsterdam"], aliases: ["the netherlands", "holland"] },
  { code: "BE", name: "Belgium", lat: 50.6, lng: 4.6, timezone: "Europe/Brussels", zones: ["Europe/Brussels"] },
  { code: "LU", name: "Luxembourg", lat: 49.8, lng: 6.1, timezone: "Europe/Luxembourg", zones: ["Europe/Luxembourg"] },
  { code: "CH", name: "Switzerland", lat: 46.8, lng: 8.2, timezone: "Europe/Zurich", zones: ["Europe/Zurich"], aliases: ["schweiz", "suisse"] },
  { code: "AT", name: "Austria", lat: 47.6, lng: 14.1, timezone: "Europe/Vienna", zones: ["Europe/Vienna"], aliases: ["österreich", "osterreich"] },
  { code: "DK", name: "Denmark", lat: 56.0, lng: 10.0, timezone: "Europe/Copenhagen", zones: ["Europe/Copenhagen"] },
  { code: "FO", name: "Faroe Islands", lat: 62.0, lng: -6.8, timezone: "Atlantic/Faroe", zones: ["Atlantic/Faroe"] },
  { code: "SE", name: "Sweden", lat: 62.2, lng: 15.6, timezone: "Europe/Stockholm", zones: ["Europe/Stockholm"] },
  { code: "NO", name: "Norway", lat: 61.4, lng: 9.0, timezone: "Europe/Oslo", zones: ["Europe/Oslo"] },
  { code: "FI", name: "Finland", lat: 64.0, lng: 26.0, timezone: "Europe/Helsinki", zones: ["Europe/Helsinki"] },
  { code: "IS", name: "Iceland", lat: 64.9, lng: -18.6, timezone: "Atlantic/Reykjavik", zones: ["Atlantic/Reykjavik"] },
  { code: "EE", name: "Estonia", lat: 58.6, lng: 25.0, timezone: "Europe/Tallinn", zones: ["Europe/Tallinn"] },
  { code: "LV", name: "Latvia", lat: 56.9, lng: 24.6, timezone: "Europe/Riga", zones: ["Europe/Riga"] },
  { code: "LT", name: "Lithuania", lat: 55.2, lng: 23.9, timezone: "Europe/Vilnius", zones: ["Europe/Vilnius"] },
  { code: "PL", name: "Poland", lat: 52.0, lng: 19.1, timezone: "Europe/Warsaw", zones: ["Europe/Warsaw"], aliases: ["polska"] },
  { code: "CZ", name: "Czechia", lat: 49.8, lng: 15.5, timezone: "Europe/Prague", zones: ["Europe/Prague"], aliases: ["czech republic"] },
  { code: "SK", name: "Slovakia", lat: 48.7, lng: 19.7, timezone: "Europe/Bratislava", zones: ["Europe/Bratislava"] },
  { code: "HU", name: "Hungary", lat: 47.2, lng: 19.5, timezone: "Europe/Budapest", zones: ["Europe/Budapest"] },
  { code: "SI", name: "Slovenia", lat: 46.1, lng: 14.9, timezone: "Europe/Ljubljana", zones: ["Europe/Ljubljana"] },
  { code: "HR", name: "Croatia", lat: 45.1, lng: 15.2, timezone: "Europe/Zagreb", zones: ["Europe/Zagreb"] },
  { code: "RS", name: "Serbia", lat: 44.0, lng: 21.0, timezone: "Europe/Belgrade", zones: ["Europe/Belgrade"] },
  { code: "RO", name: "Romania", lat: 45.9, lng: 25.0, timezone: "Europe/Bucharest", zones: ["Europe/Bucharest"] },
  { code: "BG", name: "Bulgaria", lat: 42.7, lng: 25.5, timezone: "Europe/Sofia", zones: ["Europe/Sofia"] },
  { code: "GR", name: "Greece", lat: 39.1, lng: 21.8, timezone: "Europe/Athens", zones: ["Europe/Athens"] },
  { code: "CY", name: "Cyprus", lat: 35.1, lng: 33.4, timezone: "Asia/Nicosia", zones: ["Asia/Nicosia"] },
  { code: "MT", name: "Malta", lat: 35.9, lng: 14.4, timezone: "Europe/Malta", zones: ["Europe/Malta"] },
  { code: "TR", name: "Turkey", lat: 39.0, lng: 35.2, timezone: "Europe/Istanbul", zones: ["Europe/Istanbul"], aliases: ["türkiye", "turkiye"] },
  { code: "GE", name: "Georgia", lat: 42.3, lng: 43.4, timezone: "Asia/Tbilisi", zones: ["Asia/Tbilisi"] },
  { code: "AE", name: "United Arab Emirates", lat: 23.4, lng: 53.8, timezone: "Asia/Dubai", zones: ["Asia/Dubai"], aliases: ["uae"] },
  { code: "SA", name: "Saudi Arabia", lat: 23.9, lng: 45.1, timezone: "Asia/Riyadh", zones: ["Asia/Riyadh"], aliases: ["ksa"] },
  { code: "IN", name: "India", lat: 20.6, lng: 79.0, timezone: "Asia/Kolkata", zones: ["Asia/Kolkata"] },
  { code: "CN", name: "China", lat: 35.9, lng: 104.2, timezone: "Asia/Shanghai", zones: ["Asia/Shanghai"], aliases: ["prc", "mainland china", "people's republic of china", "中国"] },
  { code: "HK", name: "Hong Kong", lat: 22.3, lng: 114.2, timezone: "Asia/Hong_Kong", zones: ["Asia/Hong_Kong"], aliases: ["hong kong sar"] },
  { code: "TW", name: "Taiwan", lat: 23.7, lng: 121.0, timezone: "Asia/Taipei", zones: ["Asia/Taipei"] },
  { code: "JP", name: "Japan", lat: 36.2, lng: 138.3, timezone: "Asia/Tokyo", zones: ["Asia/Tokyo"], aliases: ["日本"] },
  { code: "KR", name: "South Korea", lat: 35.9, lng: 127.8, timezone: "Asia/Seoul", zones: ["Asia/Seoul"], aliases: ["korea", "republic of korea", "korea, republic of"] },
  { code: "SG", name: "Singapore", lat: 1.35, lng: 103.8, timezone: "Asia/Singapore", zones: ["Asia/Singapore"] },
  { code: "MY", name: "Malaysia", lat: 4.2, lng: 101.9, timezone: "Asia/Kuala_Lumpur", zones: ["Asia/Kuala_Lumpur"] },
  { code: "ID", name: "Indonesia", lat: -2.5, lng: 118.0, timezone: null, zones: ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"] },
  { code: "TH", name: "Thailand", lat: 15.9, lng: 101.0, timezone: "Asia/Bangkok", zones: ["Asia/Bangkok"] },
  { code: "VN", name: "Vietnam", lat: 14.1, lng: 108.3, timezone: "Asia/Ho_Chi_Minh", zones: ["Asia/Ho_Chi_Minh"], aliases: ["viet nam"] },
  { code: "PH", name: "Philippines", lat: 12.9, lng: 121.8, timezone: "Asia/Manila", zones: ["Asia/Manila"] },
  { code: "AU", name: "Australia", lat: -25.3, lng: 133.8, timezone: null, zones: ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth", "Australia/Adelaide"] },
  { code: "NZ", name: "New Zealand", lat: -40.9, lng: 174.9, timezone: "Pacific/Auckland", zones: ["Pacific/Auckland"] },
  { code: "NG", name: "Nigeria", lat: 9.1, lng: 8.7, timezone: "Africa/Lagos", zones: ["Africa/Lagos"] },
  { code: "ZA", name: "South Africa", lat: -30.6, lng: 22.9, timezone: "Africa/Johannesburg", zones: ["Africa/Johannesburg"] },
  { code: "IL", name: "Israel", lat: 31.0, lng: 34.9, timezone: "Asia/Jerusalem", zones: ["Asia/Jerusalem"] },
  { code: "BR", name: "Brazil", lat: -14.2, lng: -51.9, timezone: null, zones: ["America/Sao_Paulo", "America/Manaus"] },
];

const COUNTRY_INDEX = new Map<string, CountryInfo>();
for (const c of COUNTRIES) {
  COUNTRY_INDEX.set(c.name.toLowerCase(), c);
  COUNTRY_INDEX.set(c.code.toLowerCase(), c);
  for (const a of c.aliases ?? []) COUNTRY_INDEX.set(a.toLowerCase(), c);
}

export function lookupCountry(input: string | null | undefined): CountryInfo | null {
  const s = cleanKnown(input);
  if (!s) return null;
  const key = s.toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ").trim();
  return COUNTRY_INDEX.get(key) ?? COUNTRY_INDEX.get(key.replace(/[.]/g, "")) ?? null;
}

/** "San Francisco, CA" → "San Francisco"; keeps first segment, strips US state codes. */
export function normalizeCity(input: string | null | undefined): string | null {
  const s = cleanKnown(input);
  if (!s) return null;
  const first = s.split(/[;/]/)[0].trim();
  return first.replace(/,\s*[A-Z]{2}$/, "").trim() || null;
}

/** Very small city→zone table for multi-zone countries (editable suggestion only). */
const CITY_ZONES: Record<string, string> = {
  "san francisco": "America/Los_Angeles", "los angeles": "America/Los_Angeles", "seattle": "America/Los_Angeles", "san diego": "America/Los_Angeles",
  "san jose": "America/Los_Angeles", "palo alto": "America/Los_Angeles", "mountain view": "America/Los_Angeles", "oakland": "America/Los_Angeles",
  "portland": "America/Los_Angeles", "sunnyvale": "America/Los_Angeles", "berkeley": "America/Los_Angeles", "irvine": "America/Los_Angeles",
  "denver": "America/Denver", "boulder": "America/Denver", "salt lake city": "America/Denver", "phoenix": "America/Phoenix",
  "chicago": "America/Chicago", "austin": "America/Chicago", "houston": "America/Chicago", "dallas": "America/Chicago", "minneapolis": "America/Chicago",
  "new york": "America/New_York", "boston": "America/New_York", "cambridge": "America/New_York", "pittsburgh": "America/New_York",
  "atlanta": "America/New_York", "miami": "America/New_York", "washington": "America/New_York", "detroit": "America/Detroit",
  "toronto": "America/Toronto", "montreal": "America/Toronto", "ottawa": "America/Toronto", "waterloo": "America/Toronto",
  "vancouver": "America/Vancouver", "calgary": "America/Edmonton", "edmonton": "America/Edmonton", "halifax": "America/Halifax",
  "mexico city": "America/Mexico_City", "monterrey": "America/Monterrey", "guadalajara": "America/Mexico_City", "tijuana": "America/Tijuana",
  "sydney": "Australia/Sydney", "melbourne": "Australia/Melbourne", "brisbane": "Australia/Brisbane", "perth": "Australia/Perth", "adelaide": "Australia/Adelaide",
  "jakarta": "Asia/Jakarta", "bandung": "Asia/Jakarta", "surabaya": "Asia/Jakarta",
};

export interface ZoneSuggestion {
  zone: string | null;
  confidence: "city" | "country" | "ambiguous" | "none";
  candidates: string[];
  explanation: string;
}

/** Suggest a recipient/business timezone. Always an editable suggestion. */
export function suggestTimezone(country: string | null | undefined, city: string | null | undefined): ZoneSuggestion {
  const info = lookupCountry(country);
  const cityKey = normalizeCity(city)?.toLowerCase();
  if (cityKey && CITY_ZONES[cityKey]) {
    return { zone: CITY_ZONES[cityKey], confidence: "city", candidates: info?.zones ?? [CITY_ZONES[cityKey]], explanation: `Suggested from office city "${normalizeCity(city)}".` };
  }
  if (!info) return { zone: null, confidence: "none", candidates: [], explanation: "No recognised country; choose a timezone." };
  if (info.timezone) return { zone: info.timezone, confidence: "country", candidates: info.zones, explanation: `${info.name} uses a single timezone.` };
  return { zone: null, confidence: "ambiguous", candidates: info.zones, explanation: `${info.name} spans several timezones; the city was not recognised — choose one.` };
}
