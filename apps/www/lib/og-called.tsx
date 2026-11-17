// The called-it card's link previews (1200×630), one per theme, drawn with next/og (Satori:
// flexbox only, every multi-child div is display:flex).
import { barcode, type CardData, ticket, type ThemeId } from "@/lib/called";
import { Check } from "@/lib/og";

type A = { src: string | null; bg: string };
type P = { d: CardData; a: A };

const W = { width: "100%", height: "100%", display: "flex" } as const;
const at = (d: CardData) => (d.handle ? `@${d.handle}` : d.name);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fit = (s: string, big: number, small: number) => (s.length > 70 ? small : s.length > 40 ? Math.round((big + small) / 2) : big);

function Face({ a, letter, size }: { a: A; letter: string; size: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size, background: a.bg, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {a.src ? <img src={a.src} width={size} height={size} alt="" /> : <span style={{ color: "#07080B", fontSize: size * 0.45, fontWeight: 600 }}>{letter}</span>}
    </div>
  );
}

// Geist has no ★ ▲ ▼, so the previews draw them.
const Star = ({ c }: { c: string }) => (
  <svg width={24} height={24} viewBox="0 0 24 24"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 21l1.6-7L2 9.2l7.1-.6z" fill={c} /></svg>
);
const Tri = ({ c, down }: { c: string; down?: boolean }) => (
  <svg width={24} height={24} viewBox="0 0 24 24"><path d={down ? "M3 6h18L12 20z" : "M12 4l9 14H3z"} fill={c} /></svg>
);

function Glow({ d, a }: P) {
  const claim = clip(d.claim, 110);
  return (
    <div style={{ ...W, flexDirection: "column", justifyContent: "space-between", padding: 64, background: "#0B0D12", color: "#F2F3F5", fontFamily: "Geist", backgroundImage: d.called ? "radial-gradient(ellipse 900px 520px at 100% 100%, rgba(166,227,184,0.38), transparent), radial-gradient(ellipse 700px 400px at 0% 0%, rgba(130,150,255,0.22), transparent)" : "radial-gradient(ellipse 700px 400px at 0% 0%, rgba(130,150,255,0.22), transparent)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "Geist Mono", fontSize: 34, letterSpacing: -1 }}>thesis</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "Geist Mono", fontSize: 26, letterSpacing: 1, textTransform: "uppercase", padding: "12px 24px", borderRadius: 999, background: d.called ? "#A6E3B8" : "rgba(255,255,255,0.08)", color: d.called ? "#06210F" : "#9AA0AA" }}>
          {d.called ? <Check size={28} color="#06210F" /> : null}
          {d.called ? "Called it" : "Still playing out"}
        </div>
      </div>
      <div style={{ display: "flex", fontFamily: "Geist Serif", fontSize: fit(claim, 76, 58), lineHeight: 1.1, maxWidth: 1060 }}>{claim}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Face a={a} letter={d.letter} size={76} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 32, fontWeight: 600 }}>{d.name}</span>
            <span style={{ fontSize: 26, color: "#9AA0AA" }}>{d.handle ? `@${d.handle} · ` : ""}posted {d.posted}</span>
          </div>
        </div>
        <span style={{ fontSize: 132, fontWeight: 600, letterSpacing: -5, lineHeight: 1, color: d.ret >= 0 ? "#A6E3B8" : "#F2A9C2" }}>{d.pct}</span>
      </div>
    </div>
  );
}

function Receipt({ d }: P) {
  const bars = barcode(d.id, 60);
  const scallops = Array.from({ length: 27 });
  const line = (k: string, v: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, letterSpacing: 1 }}><span>{k}</span><span>{v}</span></div>
  );
  return (
    <div style={{ ...W, alignItems: "center", justifyContent: "center", background: "#1B1A17", fontFamily: "Geist Mono", backgroundImage: "radial-gradient(ellipse 800px 500px at 50% 50%, #34312A, #12110F)" }}>
      <div style={{ display: "flex", position: "relative", width: 1000, height: 540, background: "#F5F1E8", color: "#1B1A17", transform: "rotate(-1.5deg)", padding: "44px 52px", boxShadow: "0 30px 60px rgba(0,0,0,0.5)" }}>
        <div style={{ position: "absolute", top: -11, left: 0, right: 0, display: "flex", justifyContent: "space-around" }}>
          {scallops.map((_, i) => <div key={i} style={{ width: 22, height: 22, borderRadius: 22, background: "#262420" }} />)}
        </div>
        <div style={{ position: "absolute", bottom: -11, left: 0, right: 0, display: "flex", justifyContent: "space-around" }}>
          {scallops.map((_, i) => <div key={i} style={{ width: 22, height: 22, borderRadius: 22, background: "#262420" }} />)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, paddingRight: 44, borderRight: "3px dashed rgba(27,26,23,0.3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 40, letterSpacing: 10 }}>THESIS</span>
            <span style={{ fontSize: 20, letterSpacing: 2 }}>{ticket(d.id)}</span>
          </div>
          <div style={{ display: "flex", borderTop: "3px dashed rgba(27,26,23,0.35)", margin: "18px 0" }} />
          <div style={{ display: "flex", fontSize: fit(d.claim, 34, 26), lineHeight: 1.3, textTransform: "uppercase" }}>{clip(d.claim, 100)}</div>
          <div style={{ display: "flex", flex: 1 }} />
          {line("CALLED BY", at(d).toUpperCase())}
          {line("POSTED", `${d.posted.toUpperCase()} · ${d.days}D`)}
          {line("TRADED / FADED", `${d.backs} / ${d.fades}`)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", width: 330, paddingLeft: 40, alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 22, letterSpacing: 4 }}>RETURN</span>
          <span style={{ fontSize: 84, letterSpacing: -3 }}>{d.pct}</span>
          <div style={{ display: "flex", padding: "10px 18px", border: `5px solid ${d.called ? "#1E7A43" : "#9A7B2A"}`, color: d.called ? "#1E7A43" : "#9A7B2A", borderRadius: 12, fontSize: 38, letterSpacing: 4, transform: "rotate(-10deg)" }}>{d.called ? "CALLED IT" : "PENDING"}</div>
          <div style={{ display: "flex", height: 70 }}>
            {bars.slice(0, 44).map((w, i) => <div key={i} style={{ width: w * 1.6, marginRight: i % 3 === 0 ? 4 : 3, background: "#1B1A17" }} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Terminal({ d }: P) {
  const g = d.ret >= 0 ? "#33FF66" : "#FF4D6D";
  const row = (k: string, v: string) => (
    <div style={{ display: "flex", fontSize: 26, letterSpacing: 1 }}><span style={{ color: "#33FF66", marginRight: 18 }}>&gt;</span><span style={{ width: 110, opacity: 0.7 }}>{k}</span><span>{v}</span></div>
  );
  return (
    <div style={{ ...W, flexDirection: "column", background: "#050505", color: "#FFB000", fontFamily: "Geist Mono" }}>
      <div style={{ display: "flex", justifyContent: "space-between", background: "#FFB000", color: "#050505", fontSize: 26, letterSpacing: 2, padding: "14px 40px" }}>
        <span>THESIS TERMINAL</span><span>CALL &lt;GO&gt;</span>
      </div>
      <div style={{ display: "flex", flex: 1, padding: "40px 40px 30px" }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 14, paddingRight: 30 }}>
          {row("SUBJ", clip(d.claim.toUpperCase(), 70))}
          {row("AUTH", at(d).toUpperCase())}
          {row("OPEN", `${d.posted.toUpperCase()} · ${d.days}D`)}
          {row("FLOW", `${d.backs} LONG / ${d.fades} SHORT`)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", justifyContent: "flex-end", width: 470 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 30, letterSpacing: 3, color: g }}>
            <Tri c={g} down={d.ret < 0} />
            <span>{d.called ? "CALLED" : "OPEN"}</span>
          </div>
          <span style={{ fontSize: 118, letterSpacing: -4, color: g }}>{d.pct}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 30, fontSize: 22, padding: "14px 40px", borderTop: "2px solid rgba(255,176,0,0.3)" }}>
        {d.legs.slice(0, 5).map((l, i) => <span key={i}>{clip(l.name.split(/[:(]/)[0].trim().toUpperCase(), 18)}</span>)}
      </div>
    </div>
  );
}

function Gold({ d, a }: P) {
  const claim = clip(d.claim, 90);
  return (
    <div style={{ ...W, alignItems: "center", justifyContent: "center", background: "#0B0905", backgroundImage: "radial-gradient(ellipse 800px 400px at 50% 0%, #3A2C10, transparent), radial-gradient(ellipse 700px 300px at 50% 100%, #2A1F0A, transparent)", color: "#F3E9D2", fontFamily: "Geist" }}>
      <div style={{ position: "absolute", top: 24, left: 24, right: 24, bottom: 24, display: "flex", border: "2px solid rgba(232,200,120,0.55)", borderRadius: 26 }} />
      <div style={{ position: "absolute", top: 38, left: 38, right: 38, bottom: 38, display: "flex", border: "1px solid rgba(232,200,120,0.28)", borderRadius: 16 }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", width: 980 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontFamily: "Geist Mono", fontSize: 26, letterSpacing: 12, color: "#E8C878" }}>
          <Star c="#E8C878" />
          <span>{d.called ? "CALLED IT" : "IN PLAY"}</span>
          <Star c="#E8C878" />
        </div>
        <span style={{ fontFamily: "Geist Serif", fontSize: fit(claim, 58, 44), lineHeight: 1.15, marginTop: 26 }}>“{claim}”</span>
        <span style={{ fontSize: 150, fontWeight: 600, letterSpacing: -6, lineHeight: 1, marginTop: 18, color: "#E8C878", backgroundImage: "linear-gradient(180deg, #FFF6D6 0%, #E8C878 45%, #A87B2A 100%)", backgroundClip: "text" }}>{d.pct}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18 }}>
          <Face a={a} letter={d.letter} size={50} />
          <span style={{ fontSize: 28, fontWeight: 600 }}>{d.name}</span>
          <span style={{ fontSize: 24, color: "rgba(232,200,120,0.75)", fontFamily: "Geist Mono", letterSpacing: 2 }}>· SINCE {d.posted.toUpperCase()}</span>
        </div>
      </div>
    </div>
  );
}

function Holo({ d, a }: P) {
  const claim = clip(d.claim, 90);
  return (
    <div style={{ ...W, position: "relative", flexDirection: "column", justifyContent: "space-between", padding: 60, background: "linear-gradient(125deg, #FFC8F2, #C8F4FF 30%, #D6FFC4 55%, #FFF1A8 78%, #FFC8E0)", color: "#111", fontFamily: "Geist" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, alignSelf: "flex-start", background: "rgba(255,255,255,0.7)", borderRadius: 999, padding: "6px 22px 6px 6px", fontSize: 28, fontWeight: 600 }}>
        <Face a={a} letter={d.letter} size={52} />
        {at(d)}
      </div>
      <div style={{ position: "absolute", top: 50, right: 60, display: "flex", background: "#111", color: "#fff", fontSize: 40, fontWeight: 600, padding: "14px 26px", borderRadius: 20, transform: "rotate(7deg)", boxShadow: "6px 8px 0 rgba(0,0,0,0.18)" }}>{d.called ? "CALLED IT!!" : "NOT YET…"}</div>
      <div style={{ display: "flex", fontSize: fit(claim, 62, 46), fontWeight: 600, letterSpacing: -2, lineHeight: 1.05, maxWidth: 900 }}>{claim}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <span style={{ fontSize: 170, fontWeight: 600, letterSpacing: -9, lineHeight: 0.85 }}>{d.pct}</span>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", fontFamily: "Geist Mono", fontSize: 22, letterSpacing: 1 }}>
          <span>SINCE {d.posted.toUpperCase()}</span>
          <span style={{ fontSize: 34, marginTop: 6 }}>thesis</span>
        </div>
      </div>
    </div>
  );
}

function Press({ d }: P) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).toUpperCase();
  const head = d.called ? `${at(d)} called it` : `${at(d)} makes the call`;
  return (
    <div style={{ ...W, flexDirection: "column", padding: "34px 56px 40px", background: "#EFE8D8", color: "#161412", fontFamily: "Geist Serif" }}>
      <div style={{ display: "flex", justifyContent: "center", fontSize: 60, letterSpacing: -1, paddingBottom: 10 }}>The Thesis Times</div>
      <div style={{ display: "flex", borderTop: "2px solid #161412", borderBottom: "2px solid #161412", height: 7 }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "Geist Mono", fontSize: 18, letterSpacing: 2, padding: "8px 0", borderBottom: "2px solid #161412" }}>
        <span>{today}</span><span>LATE EDITION</span><span>THESIS</span>
      </div>
      <div style={{ display: "flex", flex: 1, gap: 40, marginTop: 26 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <span style={{ fontSize: head.length > 24 ? 68 : 84, lineHeight: 0.95, letterSpacing: -2, textTransform: "uppercase" }}>{head}</span>
          <span style={{ fontSize: fit(d.claim, 36, 28), lineHeight: 1.2, marginTop: 18, opacity: 0.85 }}>“{clip(d.claim, 110)}”</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", width: 300, borderLeft: "2px solid #161412", paddingLeft: 32, justifyContent: "flex-end" }}>
          <span style={{ fontSize: 104, lineHeight: 0.9, letterSpacing: -4 }}>{d.pct}</span>
          <span style={{ fontFamily: "Geist", fontSize: 20, lineHeight: 1.35, marginTop: 14 }}>{`Posted ${d.posted}. ${d.backs} traded it, ${d.fades} faded it.`}</span>
        </div>
      </div>
    </div>
  );
}

export function CalledOg({ theme, d, a }: { theme: ThemeId } & P) {
  switch (theme) {
    case "receipt": return <Receipt d={d} a={a} />;
    case "terminal": return <Terminal d={d} a={a} />;
    case "gold": return <Gold d={d} a={a} />;
    case "holo": return <Holo d={d} a={a} />;
    case "press": return <Press d={d} a={a} />;
    default: return <Glow d={d} a={a} />;
  }
}
