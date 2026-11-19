import LegMark from "./LegMark";
import { cardValue, isCardKind, legName, SERIES, type ReceiptLeg, type TakeLeg } from "@/lib/data";

// `receipt`: the on-chain legs, for what only the chain knows (a card leg's insured value).
// `keys`: each catalog row's logo key by asset id (assetKeys), for the legs' logos.
export default function Basket({ legs, receipt, keys = {} }: { legs: TakeLeg[]; receipt?: ReceiptLeg[]; keys?: Record<string, string> }) {
  const card = (l: TakeLeg) => receipt?.find((r) => r.card && r.name.toLowerCase() === l.name.toLowerCase())?.card ?? null;
  return (
    <>
      <div className="bar">
        {legs.map((l) => (
          <span key={l.slot} style={{ flex: l.weight, background: SERIES[l.slot % SERIES.length] }} />
        ))}
      </div>
      {legs.map((l) => (
        <div className="leg" key={l.slot}>
          <LegMark assetKey={(l.asset_id && keys[l.asset_id]) || null} name={l.name} kind={l.kind} color={SERIES[l.slot % SERIES.length]} />
          <div>
            <div>{legName(l.name)}</div>
            {l.why ? <div className="note">{l.why}</div> : null}
          </div>
          <div className="mono small" style={{ textAlign: "right" }}>
            {Math.round(l.weight)}%<div className="note">{isCardKind(l.kind) ? cardValue(card(l)?.insuredValueUsd) : l.kind}</div>
          </div>
        </div>
      ))}
    </>
  );
}
