import type { IdlAccounts, IdlEvents, IdlTypes } from "@anchor-lang/core";
import type { Thesis } from "../idl/thesis.ts";

export type { Thesis };

type T = IdlTypes<Thesis>;

export type ConfigParams = T["configParams"];
export type UpdateConfigArgs = T["updateConfigArgs"];
export type CreateTakeArgs = T["createTakeArgs"];
export type OpenPositionArgs = T["openPositionArgs"];
export type LegSpec = T["legSpec"];
export type LegPrice = T["legPrice"];
export type Risk = T["risk"];
export type Side = T["side"];
export type LegKind = T["legKind"];
export type FadeVia = T["fadeVia"];
export type BadgeKind = T["badgeKind"];

export type TakeAccount = IdlAccounts<Thesis>["take"];
export type PositionAccount = IdlAccounts<Thesis>["position"];
export type ProfileAccount = IdlAccounts<Thesis>["profile"];
export type ExitAccount = IdlAccounts<Thesis>["exit"];

export type ThesisEvents = IdlEvents<Thesis>;

// Enum values in the shape Anchor expects.
export const RISK = { low: { low: {} }, medium: { medium: {} }, high: { high: {} } } as const;
export const SIDE = { back: { back: {} }, fade: { fade: {} } } as const;
export const LEG_KIND = {
  spot: { spot: {} },
  yield: { yield: {} },
  perp: { perp: {} },
  prediction: { prediction: {} },
  card: { card: {} },
} as const;
export const FADE_VIA = {
  none: { none: {} },
  phoenixShort: { phoenixShort: {} },
  predictionNo: { predictionNo: {} },
} as const;

/** The badge catalog, in program order (the index is part of each badge's mint address). */
export const BADGE_KIND = {
  firstTake: { firstTake: {} },
  firstOver50: { firstOver50: {} },
  firstOver100: { firstOver100: {} },
  tenOver50: { tenOver50: {} },
  over1000: { over1000: {} },
} as const;
export type BadgeKindName = keyof typeof BADGE_KIND;
export const BADGE_KIND_INDEX: Record<BadgeKindName, number> = {
  firstTake: 0,
  firstOver50: 1,
  firstOver100: 2,
  tenOver50: 3,
  over1000: 4,
};
/** Each badge's on-chain name and URI slug (`BadgeKind::name` / `slug` in the program's state.rs). */
export const BADGE_META: Record<BadgeKindName, { name: string; slug: string }> = {
  firstTake: { name: "Thesis: First take", slug: "first-take" },
  firstOver50: { name: "Called it: +50%", slug: "first-50" },
  firstOver100: { name: "Called it: +100%", slug: "first-100" },
  tenOver50: { name: "Called it: 10x +50%", slug: "ten-50" },
  over1000: { name: "Called it: +1,000%", slug: "over-1000" },
};

/** A badge's metadata URI under the config's `badgeUriBase`, as the program builds it. */
export const badgeMetadataUri = (base: string, kind: BadgeKindName) => `${base}${BADGE_META[kind].slug}.json`;

/** The public `badges` bucket in Supabase Storage, as a badge URI base. */
export const supabaseBadgeUriBase = (supabaseUrl: string) => `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/badges/`;
