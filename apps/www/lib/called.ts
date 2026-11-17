// The "called it" card: the data every theme draws, and the themes ("filters") themselves.
// Shared by the page (components/CalledCard.tsx) and its link preview (lib/og-called.tsx).
import { avatar, calledIt, legName, nameOf, pct, type Receipt, SERIES, shortDate, since, type Take, takeReturn } from "@/lib/data";

export const THEMES = [
  { id: "glow", name: "Glow", swatch: "radial-gradient(circle at 70% 75%, #A6E3B8, #1B3A2A 55%, #0B0D12)" },
  { id: "receipt", name: "Receipt", swatch: "repeating-linear-gradient(90deg, #1a1a1a 0 2px, #F5F1E8 2px 5px)" },
  { id: "terminal", name: "Terminal", swatch: "linear-gradient(#050505, #050505) padding-box, linear-gradient(#FFB000, #FFB000)" },
  { id: "gold", name: "Gold", swatch: "linear-gradient(160deg, #FFF1C1, #E8C878 45%, #8A6420)" },
  { id: "holo", name: "Holo", swatch: "linear-gradient(135deg, #FFC8F2, #C8F4FF 35%, #D6FFC4 60%, #FFF1A8 80%, #FFC8E0)" },
  { id: "press", name: "Front page", swatch: "linear-gradient(#EFE8D8, #EFE8D8)" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const themeOf = (v: unknown): ThemeId => (THEMES.find((t) => t.id === v)?.id ?? "glow");

export type CardData = {
  id: string;
  claim: string;
  ret: number;
  pct: string;
  called: boolean;
  name: string;
  handle: string | null;
  avatar: { src: string | null; bg: string };
  letter: string;
  posted: string;
  since: string;
  days: number;
  backs: number;
  fades: number;
  onChain: boolean;
  legs: { name: string; color: string; weight: number }[];
};

export function cardData(take: Take, receipt: Receipt | null): CardData {
  const ret = takeReturn(take, receipt);
  const legs = [...take.legs].sort((a, b) => b.weight - a.weight);
  return {
    id: take.id,
    claim: take.claim,
    ret,
    pct: pct(ret),
    called: calledIt(ret),
    name: nameOf(take.author),
    handle: take.author.handle,
    avatar: avatar(take.author.avatar_url),
    letter: (take.author.handle ?? take.author.display_name ?? "?").slice(0, 1).toUpperCase(),
    posted: shortDate(take.created_at),
    since: since(take.created_at),
    days: Math.max(0, Math.floor((Date.now() - new Date(take.created_at).getTime()) / 86_400_000)),
    backs: take.backs,
    fades: take.fades,
    onChain: !!receipt?.onChain,
    legs: legs.map((l, i) => ({ name: legName(l.name), color: SERIES[i % SERIES.length], weight: l.weight })),
  };
}

/** A barcode for the receipt theme, the same every time for a take. */
export function barcode(id: string, bars = 46): number[] {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: bars }, () => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return 1 + ((h >>> 0) % 4);
  });
}

/** Ticket-ish number from the take id: "No. 4F2A-91C0". */
export const ticket = (id: string) => `No. ${id.replace(/-/g, "").slice(-8, -4).toUpperCase()}-${id.slice(-4).toUpperCase()}`;

/** Smaller type for longer claims. */
export const claimSize = (claim: string, big: number, small: number) =>
  claim.length > 90 ? small : claim.length > 50 ? Math.round((big + small) / 2) : big;
