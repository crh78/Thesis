// USDC yield: Kamino Earn vaults (kvault) and Jupiter Lend Earn.
import { getJson, mapLimit } from "../lib/http.ts";
import { COMMON_SOURCES, USDC } from "../curated.ts";

export type YieldVault = {
  venue: "Kamino Earn" | "Jupiter Lend Earn";
  name: string;
  address: string; // vault (Kamino) or jl-token mint (Jupiter Lend)
  shareMint: string;
  program: string;
  tvlUsd: number;
  apyPct: number | null;
  apy7dPct: number | null;
  apy30dPct: number | null;
  holders: number | null;
  feesNote: string | null;
  apyUnitNote: string;
};

const KVAULT_PROGRAM = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const JUP_LEND_PROGRAM = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";

export async function loadKamino(top = 8): Promise<{ usdcVaultCount: number; vaults: YieldVault[] }> {
  const all = await getJson<any[]>(COMMON_SOURCES.kaminoVaults);
  const usdc = all.filter((v) => v.state?.tokenMint === USDC);
  const ranked = usdc
    .map((v) => ({ v, aum: Number(v.state.prevAum) / 10 ** Number(v.state.tokenMintDecimals ?? 6) }))
    .filter((x) => !/test/i.test(x.v.state.name ?? ""))
    .sort((a, b) => b.aum - a.aum)
    .slice(0, top);
  const vaults = await mapLimit(ranked, 3, async ({ v, aum }): Promise<YieldVault> => {
    let m: any = null;
    try {
      m = await getJson<any>(COMMON_SOURCES.kaminoMetrics.replace("{vault}", v.address));
    } catch {
      m = null;
    }
    const pct = (x: any) => (x === undefined || x === null ? null : Number(x) * 100);
    return {
      venue: "Kamino Earn",
      name: v.state.name || v.address,
      address: v.address,
      shareMint: v.state.sharesMint,
      program: v.programId ?? KVAULT_PROGRAM,
      tvlUsd: m ? Number(m.tokensInvestedUsd) + Number(m.tokensAvailableUsd) : aum,
      apyPct: pct(m?.apy),
      apy7dPct: pct(m?.apy7d),
      apy30dPct: pct(m?.apy30d),
      holders: m?.numberOfHolders ?? null,
      feesNote: `perf ${v.state.performanceFeeBps} bps, mgmt ${v.state.managementFeeBps} bps`,
      apyUnitNote: "Kamino metrics API returns APY as a fraction; shown as %",
    };
  });
  return { usdcVaultCount: usdc.length, vaults };
}

export async function loadJupiterLend(): Promise<YieldVault[]> {
  const list = await getJson<any[]>(COMMON_SOURCES.jupiterLend);
  return list
    .filter((t) => t.asset?.symbol === "USDC" || t.assetAddress === USDC)
    .map((t) => {
      const dec = Number(t.decimals ?? 6);
      const price = Number(t.asset?.price ?? 1);
      return {
        venue: "Jupiter Lend Earn" as const,
        name: String(t.name ?? t.symbol).split(/\s+/).filter(Boolean).join(" "),
        address: t.address,
        shareMint: t.address,
        program: JUP_LEND_PROGRAM,
        tvlUsd: (Number(t.totalAssets) / 10 ** dec) * price,
        apyPct: Number(t.totalRate) / 100,
        apy7dPct: null,
        apy30dPct: null,
        holders: null,
        feesNote: `supplyRate ${t.supplyRate}, rewardsRate ${t.rewardsRate}`,
        apyUnitNote: "totalRate read as basis points (550 = 5.50%); unit unverified in Jupiter docs",
      };
    });
}
