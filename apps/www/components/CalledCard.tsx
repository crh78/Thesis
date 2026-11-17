// One "called it" card per theme, drawn for a phone screen (4:5). Styles in app/c/[id]/called.css.
import { barcode, type CardData, claimSize, ticket, type ThemeId } from "@/lib/called";

type Props = { d: CardData; theme: ThemeId; shown: string };

function Face({ d, size }: { d: CardData; size: number }) {
  return (
    <span className="cc-face" style={{ width: size, height: size, background: d.avatar.bg }}>
      {d.avatar.src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={d.avatar.src} alt="" />
      ) : (
        <b>{d.letter}</b>
      )}
    </span>
  );
}

const at = (d: CardData) => (d.handle ? `@${d.handle}` : d.name);

function Glow({ d, shown }: Omit<Props, "theme">) {
  return (
    <div className={`cc cc-glow ${d.called ? "" : "cc-meh"}`}>
      <div className="cc-row">
        <span className="cc-badge">{d.called ? "✓ Called it" : "Still playing out"}</span>
        <span className="cc-caps">{d.since}</span>
      </div>
      <div className="cc-claim" style={{ fontSize: claimSize(d.claim, 34, 24) }}>{d.claim}</div>
      <div className="cc-spacer" />
      <div className={`cc-num ${d.ret >= 0 ? "up" : "down"}`}>{shown}</div>
      <div className="cc-caps">since {d.posted}{d.onChain ? " · on-chain" : ""}</div>
      {d.legs.length ? (
        <div className="cc-bar">
          {d.legs.map((l, i) => <span key={i} style={{ flex: l.weight, background: l.color }} />)}
        </div>
      ) : null}
      <div className="cc-row cc-foot">
        <span className="cc-who"><Face d={d} size={30} />{d.name}</span>
        <span className="cc-mark">thesis</span>
      </div>
    </div>
  );
}

function ReceiptCard({ d, shown }: Omit<Props, "theme">) {
  return (
    <div className="cc cc-receipt">
      <div className="cc-r-head">
        <b>THESIS</b>
        <span>TAKE RECEIPT</span>
        <span>{ticket(d.id)}</span>
      </div>
      <div className="cc-r-rule" />
      <div className="cc-r-claim" style={{ fontSize: claimSize(d.claim, 17, 13) }}>{d.claim}</div>
      <div className="cc-r-rule" />
      <div className="cc-r-line"><span>CALLED BY</span><span>{at(d)}</span></div>
      <div className="cc-r-line"><span>POSTED</span><span>{d.posted.toUpperCase()}</span></div>
      <div className="cc-r-line"><span>HELD</span><span>{d.days} DAY{d.days === 1 ? "" : "S"}</span></div>
      <div className="cc-r-line"><span>TRADED / FADED</span><span>{d.backs} / {d.fades}</span></div>
      <div className="cc-r-rule" />
      <div className="cc-r-total"><span>RETURN</span><b>{shown}</b></div>
      <div className="cc-spacer" />
      <div className="cc-r-code">
        {barcode(d.id).map((w, i) => <i key={i} style={{ width: w, marginRight: i % 3 === 0 ? 3 : 2 }} />)}
      </div>
      <div className="cc-r-thanks">THANK YOU FOR TRADING</div>
      <div className={`cc-stamp ${d.called ? "" : "cc-stamp-pending"}`}>{d.called ? "CALLED IT" : "PENDING"}</div>
    </div>
  );
}

function Terminal({ d, shown }: Omit<Props, "theme">) {
  return (
    <div className="cc cc-term">
      <div className="cc-t-bar"><span>THESIS</span><span>CALL &lt;GO&gt;</span></div>
      <div className="cc-t-body">
        <div><em>&gt;</em> SUBJ  {d.claim.toUpperCase()}</div>
        <div><em>&gt;</em> AUTH  {at(d).toUpperCase()}</div>
        <div><em>&gt;</em> OPEN  {d.posted.toUpperCase()} · {d.days}D</div>
        <div><em>&gt;</em> FLOW  {d.backs} LONG / {d.fades} SHORT</div>
      </div>
      <div className="cc-spacer" />
      <div className="cc-t-label">{d.called ? "▲ CALLED" : d.ret >= 0 ? "▲ OPEN" : "▼ OPEN"}</div>
      <div className={`cc-t-num ${d.ret >= 0 ? "" : "neg"}`}>{shown}<span className="cc-t-cur">█</span></div>
      <div className="cc-t-tape">
        {d.legs.slice(0, 4).map((l, i) => <span key={i}>{l.name.split(/[:(]/)[0].trim().toUpperCase()}</span>)}
      </div>
    </div>
  );
}

function Gold({ d, shown }: Omit<Props, "theme">) {
  return (
    <div className="cc cc-gold">
      <div className="cc-g-frame" />
      <div className="cc-g-top">★ {d.called ? "CALLED IT" : "IN PLAY"} ★</div>
      <div className="cc-g-claim" style={{ fontSize: claimSize(d.claim, 27, 20) }}>“{d.claim}”</div>
      <div className="cc-spacer" />
      <div className="cc-g-num">{shown}</div>
      <div className="cc-g-sub">since {d.posted}</div>
      <div className="cc-g-who"><Face d={d} size={34} /><span>{d.name}<small>{d.handle ? `@${d.handle}` : ""}</small></span></div>
      <div className="cc-g-cert">certified on thesis</div>
    </div>
  );
}

function Holo({ d, shown }: Omit<Props, "theme">) {
  return (
    <div className="cc cc-holo">
      <div className="cc-h-sticker">{d.called ? "CALLED IT!!" : "NOT YET…"}</div>
      <span className="cc-h-pill"><Face d={d} size={26} />{at(d)}</span>
      <div className="cc-h-claim" style={{ fontSize: claimSize(d.claim, 34, 24) }}>{d.claim}</div>
      <div className="cc-spacer" />
      <div className="cc-h-num">{shown}</div>
      <div className="cc-row">
        <span className="cc-h-small">since {d.posted} ✦ {d.backs} traded</span>
        <span className="cc-h-small"><b>thesis</b></span>
      </div>
    </div>
  );
}

function Press({ d, shown }: Omit<Props, "theme">) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).toUpperCase();
  return (
    <div className="cc cc-press">
      <div className="cc-p-mast">The Thesis Times</div>
      <div className="cc-p-date"><span>{today}</span><span>LATE EDITION</span><span>THESIS</span></div>
      <div className="cc-p-head">{d.called ? `${at(d)} called it` : `${at(d)} makes the call`}</div>
      <div className="cc-p-dek" style={{ fontSize: claimSize(d.claim, 19, 15) }}>“{d.claim}”</div>
      <div className="cc-spacer" />
      <div className="cc-p-cols">
        <div className="cc-p-num">{shown}</div>
        <div className="cc-p-copy">
          Posted {d.posted}, {d.days} day{d.days === 1 ? "" : "s"} ago. {d.backs} traded it, {d.fades} faded it.
          <i> Story continues on thesis.</i>
        </div>
      </div>
    </div>
  );
}

export default function CalledCard({ d, theme, shown }: Props) {
  switch (theme) {
    case "receipt": return <ReceiptCard d={d} shown={shown} />;
    case "terminal": return <Terminal d={d} shown={shown} />;
    case "gold": return <Gold d={d} shown={shown} />;
    case "holo": return <Holo d={d} shown={shown} />;
    case "press": return <Press d={d} shown={shown} />;
    default: return <Glow d={d} shown={shown} />;
  }
}
