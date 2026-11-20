import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, F, prog, rand, sp } from "./theme";
import { Avatar, Brand, Donut } from "./ui";

/**
 * Cut into the reel between +$20K and +$100K: his phone at night, the group chat going off.
 * Friends back and fade his take, someone says half of X is copying him, and Thesis notifications stack up.
 */
export const INSERT = 200; // frames at 30 fps

const PICKS = [
  { k: "KALSHI", w: 30 }, { k: "DKNG", w: 25 }, { k: "POLYMARKET", w: 20 }, { k: "COIN", w: 15 }, { k: "HOOD", w: 10 },
];

type Msg =
  | { at: number; who: string; av: 0 | 1; text: string; card?: boolean; x?: boolean }
  | { at: number; me: true; text: string }
  | { at: number; sys: string; tone: "back" | "fade" };

const MSGS: Msg[] = [
  { at: 4, who: "Kai", av: 0, text: "yo is this ur take??", card: true },
  { at: 30, who: "Maya", av: 1, text: "backed it 🫡" },
  { at: 38, sys: "Maya backed your take · $50", tone: "back" },
  { at: 54, who: "Dre", av: 0, text: "fading. it's a bubble 🫧" },
  { at: 62, sys: "Dre faded your take · $20", tone: "fade" },
  { at: 80, who: "Kai", av: 0, text: "BRO hella ppl copy trading u on X", x: true },
  { at: 112, who: "Dre", av: 0, text: "ok unfading 💀" },
  { at: 120, sys: "Dre backed your take · $100", tone: "back" },
  { at: 138, me: true, text: "told y'all" },
];

const NOTES = [
  { at: 44, app: "THESIS", title: "128 people backed your take", body: "Everyone is betting on everything" },
  { at: 92, app: "X", title: "@macromike is copy trading you", body: "“this guy is onto something”" },
  { at: 124, app: "THESIS", title: "You earned $412 in author fees", body: "5 bps of every back and fade" },
  { at: 150, app: "THESIS", title: "Your take is up +312%", body: "Called it? Your badge is waiting." },
];

const TakeCard: React.FC = () => (
  <div style={{ marginTop: 10, width: 420, borderRadius: 18, overflow: "hidden", background: "#0F1014", border: `1px solid ${C.hair}` }}>
    <div style={{ padding: 16, display: "flex", gap: 14, alignItems: "center" }}>
      <Donut weights={PICKS.map((p) => p.w)} size={78} stroke={10} />
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: F.mono, fontSize: 12, color: C.muted, letterSpacing: 1 }}>@DEV · 5 PICKS · HIGH</div>
        <div style={{ fontFamily: F.serif, fontSize: 22, color: C.text, marginTop: 4, lineHeight: 1.15 }}>Everyone is betting on everything</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>{PICKS.map((p) => <Brand key={p.k} k={p.k} size={24} />)}</div>
      </div>
      <div style={{ fontFamily: F.mono, fontSize: 24, color: C.up, alignSelf: "flex-start" }}>+312%</div>
    </div>
    <div style={{ display: "flex", borderTop: `1px solid ${C.hair}` }}>
      <div style={{ flex: 1, padding: "11px 0", textAlign: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 17, color: "#06210F", background: "linear-gradient(90deg,#BDEDCB,#97DBAB)" }}>Back it</div>
      <div style={{ flex: 1, padding: "11px 0", textAlign: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 17, color: "#3A0A1C", background: "linear-gradient(90deg,#F7C9D9,#F3B6CC)" }}>Fade it</div>
    </div>
  </div>
);

const XMini: React.FC = () => (
  <div style={{ marginTop: 10, width: 400, borderRadius: 16, padding: 14, background: "#000", border: "1px solid #2F3336" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Avatar n={1} size={34} />
      <div style={{ fontFamily: F.sans, fontSize: 15, color: "#E7E9EA" }}><b>macro mike</b> <span style={{ color: "#71767B" }}>@macromike · 4m</span></div>
    </div>
    <div style={{ fontFamily: F.sans, fontSize: 17, color: "#E7E9EA", marginTop: 8 }}>copying @dev on this one. the house always wins</div>
    <div style={{ marginTop: 10, display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 999, background: "rgba(169,227,186,0.12)", fontFamily: F.mono, fontSize: 14, color: C.up }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: C.up }} /> 1,284 copy trading @dev
    </div>
  </div>
);

const Row: React.FC<{ m: Msg; o: number }> = ({ m, o }) => {
  const t = { opacity: o, transform: `translateY(${(1 - o) * 16}px) scale(${0.96 + 0.04 * o})` };
  if ("sys" in m) {
    const col = m.tone === "back" ? C.up : C.fade;
    return (
      <div style={{ ...t, alignSelf: "center", display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderRadius: 999, background: `${col}1F`, border: `1px solid ${col}55`, fontFamily: F.mono, fontSize: 15, color: col }}>
        <span>{m.tone === "back" ? "▲" : "▼"}</span>{m.sys}
      </div>
    );
  }
  if ("me" in m) {
    return <div style={{ ...t, alignSelf: "flex-end", transformOrigin: "right bottom", padding: "12px 18px", borderRadius: 22, background: "#0A84FF", fontFamily: F.sans, fontSize: 21, color: "#fff" }}>{m.text}</div>;
  }
  return (
    <div style={{ ...t, display: "flex", gap: 10, alignItems: "flex-end", transformOrigin: "left bottom" }}>
      <Avatar n={m.av} size={36} />
      <div>
        <div style={{ fontFamily: F.sans, fontSize: 14, color: C.muted, margin: "0 12px 4px" }}>{m.who}</div>
        <div style={{ padding: "12px 18px", borderRadius: 22, background: "#26272B", fontFamily: F.sans, fontSize: 21, color: "#fff", maxWidth: 440 }}>
          {m.text}
          {m.card ? <TakeCard /> : null}
          {m.x ? <XMini /> : null}
        </div>
      </div>
    </div>
  );
};

export const GroupChatInsert: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeIO = interpolate(f, [0, 6, INSERT - 8, INSERT], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // the thread scrolls up as messages pile in
  const shown = MSGS.filter((m) => f >= m.at).length;
  const scroll = interpolate(f, [0, 34, 70, 110, 150, INSERT], [0, 0, 150, 400, 540, 560], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const buzz = f % 22 < 3 && f > 30 ? (rand(f) - 0.5) * 6 : 0;
  return (
    <AbsoluteFill style={{ background: "radial-gradient(70% 80% at 35% 50%, #1B2340, #07080B 75%)", opacity: fadeIO }}>
      {/* dust in the dark room */}
      {Array.from({ length: 40 }, (_, i) => (
        <div key={i} style={{ position: "absolute", left: rand(i) * 1920, top: (rand(i + 9) * 1080 - f * (0.2 + rand(i + 3) * 0.4) + 1080) % 1080, width: 3, height: 3, borderRadius: 2, background: "#fff", opacity: 0.08 + 0.1 * rand(i + 5) }} />
      ))}
      {/* phone */}
      <div style={{ position: "absolute", left: 130, top: 24, width: 720, height: 1032, borderRadius: 80, padding: 14, background: "linear-gradient(145deg,#2a2d33,#0d0e11)", boxShadow: "0 50px 140px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.08), 0 0 120px rgba(80,120,255,0.25)", transform: `translateX(${buzz}px) rotate(${-2 + buzz * 0.1}deg)` }}>
        <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: 66, overflow: "hidden", background: "#000" }}>
          <div style={{ position: "absolute", inset: 0, zoom: 1.32 }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 2, padding: "56px 0 18px", textAlign: "center", background: "rgba(18,18,20,0.94)", borderBottom: `1px solid ${C.hair}` }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
              <Avatar n={0} size={40} /><div style={{ marginLeft: -12 }}><Avatar n={1} size={40} /></div>
            </div>
            <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 18, color: C.text }}>the boys 🏀</div>
            <div style={{ fontFamily: F.sans, fontSize: 13, color: C.muted }}>{3 + shown} new messages</div>
          </div>
          <div style={{ position: "absolute", left: 22, right: 22, top: 190, display: "flex", flexDirection: "column", gap: 16, transform: `translateY(${-scroll}px)` }}>
            {MSGS.map((m, i) => <Row key={i} m={m} o={prog(f, m.at, m.at + 8)} />)}
          </div>
          </div>
        </div>
      </div>
      {/* notifications stacking on the right */}
      <div style={{ position: "absolute", left: 700, top: 70, width: 760, display: "flex", flexDirection: "column", gap: 20, zoom: 1.25 }}>
        {NOTES.map((n, i) => {
          const s = sp(f, fps, n.at, 16);
          return (
            <div key={i} style={{ opacity: s, transform: `translateY(${(1 - s) * -40}px) scale(${0.94 + 0.06 * s})`, display: "flex", gap: 18, alignItems: "center", padding: "20px 24px", borderRadius: 30, background: "rgba(40,42,48,0.78)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 24px 60px rgba(0,0,0,0.5)", backdropFilter: "blur(20px)" }}>
              <div style={{ width: 58, height: 58, borderRadius: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: n.app === "X" ? "#000" : "#0F1014", border: `1px solid ${C.hair}`, fontFamily: n.app === "X" ? F.sans : F.pixel, fontWeight: 700, fontSize: n.app === "X" ? 30 : 20, color: "#fff" }}>{n.app === "X" ? "𝕏" : "th"}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: F.sans, fontSize: 16, color: C.muted, letterSpacing: 0.5 }}><span>{n.app}</span><span>now</span></div>
                <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 27, color: C.text, marginTop: 2 }}>{n.title}</div>
                <div style={{ fontFamily: F.sans, fontSize: 21, color: C.muted, marginTop: 2 }}>{n.body}</div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Over the Seedance "phone blows up" shot (whose generated text is unreadable): the video softens and
 * crisp notifications and texts drop in, so you can read that people are backing and copy trading him.
 */
export const CHAT_OVERLAY = 118; // frames
const DROPS: { app: "THESIS" | "X" | "MSG"; title: string; body: string; glow: string }[] = [
  { app: "MSG", title: "Kai: yo is this ur take??", body: "the boys 🏀", glow: "#0A84FF" },
  { app: "THESIS", title: "128 people backed your take", body: "Everyone is betting on everything", glow: "#A6E3B8" },
  { app: "X", title: "@macromike is copy trading you", body: "“copying @dev on this one”", glow: "#8296FF" },
  { app: "MSG", title: "Kai: BRO hella ppl copy trading u on X 😭", body: "the boys 🏀", glow: "#0A84FF" },
  { app: "X", title: "1,284 people are copy trading you", body: "Your next take goes out to all of them", glow: "#8296FF" },
  { app: "THESIS", title: "You earned $412 in author fees", body: "5 bps of every back and fade", glow: "#A6E3B8" },
];

export const ChatOverlay: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = interpolate(f, [CHAT_OVERLAY - 8, CHAT_OVERLAY], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ alignItems: "center", opacity: out }}>
      <div style={{ marginTop: 120, width: 860, display: "flex", flexDirection: "column", gap: 18 }}>
        {DROPS.map((n, i) => {
          const s = sp(f, fps, 4 + i * 11, 15);
          const icon = n.app === "X" ? "𝕏" : n.app === "MSG" ? "💬" : "th";
          return (
            <div key={i} style={{ opacity: s, transform: `translateY(${(1 - s) * -36}px) scale(${0.92 + 0.08 * s})`, display: "flex", gap: 22, alignItems: "center", padding: "20px 26px", borderRadius: 30, background: "rgba(22,24,30,0.86)", border: `2px solid ${n.glow}88`, boxShadow: `0 0 28px ${n.glow}55, 0 20px 50px rgba(0,0,0,0.5)` }}>
              <div style={{ width: 64, height: 64, borderRadius: 16, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: n.app === "MSG" ? "#30D158" : n.app === "X" ? "#000" : "#0F1014", border: `1px solid ${C.hair}`, fontFamily: n.app === "THESIS" ? F.pixel : F.sans, fontWeight: 700, fontSize: n.app === "THESIS" ? 24 : 34, color: "#fff" }}>{icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: F.sans, fontSize: 18, color: C.muted }}><span>{n.app === "MSG" ? "MESSAGES" : n.app}</span><span>now</span></div>
                <div style={{ fontFamily: F.sans, fontWeight: 700, fontSize: 31, color: "#fff", marginTop: 2 }}>{n.title}</div>
                <div style={{ fontFamily: F.sans, fontSize: 23, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>{n.body}</div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
