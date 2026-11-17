import { cardValue, isCardKind, legName, SERIES, type ReceiptLeg, type TakeLeg } from "@/lib/data";

// `receipt`: the on-chain legs, for what only the chain knows (a card leg's insured value).
export default function Basket({ legs, receipt }: { legs: TakeLeg[]; receipt?: ReceiptLeg[] }) {
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
          <span className="dot" style={{ background: SERIES[l.slot % SERIES.length] }} />
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
