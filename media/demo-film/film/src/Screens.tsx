import React from "react";
import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, F } from "./theme";
import { Avatar, Brand, Donut } from "./ui";

/** Phone screens used as Seedance reference images (rendered as stills, 1179×2556). */
export const SW = 1179, SH = 2556;

const PICKS = [{ k: "KALSHI", w: 30 }, { k: "DKNG", w: 25 }, { k: "POLYMARKET", w: 20 }, { k: "COIN", w: 15 }, { k: "HOOD", w: 10 }];

const Status: React.FC<{ time?: string }> = ({ time = "3:12" }) => (
  <div style={{ position: "absolute", top: 50, left: 110, right: 110, display: "flex", justifyContent: "space-between", fontFamily: F.sans, fontWeight: 600, fontSize: 52, color: "#fff" }}>
    <span>{time}</span><span>●●●  ▮</span>
  </div>
);

const Icon: React.FC<{ app: "THESIS" | "X" }> = ({ app }) => (
  <div style={{ width: 120, height: 120, borderRadius: 28, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: app === "X" ? "#000" : "#0F1014", border: "2px solid rgba(255,255,255,0.15)", fontFamily: app === "X" ? F.sans : F.pixel, fontWeight: 700, fontSize: app === "X" ? 66 : 44, color: "#fff" }}>{app === "X" ? "𝕏" : "th"}</div>
);

const NOTES: { app: "THESIS" | "X"; title: string; body: string }[] = [
  { app: "THESIS", title: "128 people backed your take", body: "Everyone is betting on everything" },
  { app: "X", title: "@macromike is copy trading you", body: "“copying @dev on this one”" },
  { app: "X", title: "1,284 people are copy trading you", body: "Your next take goes out to all of them" },
  { app: "THESIS", title: "You earned $412 in author fees", body: "5 bps of every back and fade" },
  { app: "THESIS", title: "Your take is up +312%", body: "Kalshi, DraftKings, Polymarket +2" },
];

/** Lock screen buried in notifications. */
export const NotifScreen: React.FC = () => (
  <AbsoluteFill style={{ background: "linear-gradient(180deg,#1B2340 0%,#0B0D16 60%,#07080B)" }}>
    <Status time="" />
    <div style={{ position: "absolute", top: 230, width: "100%", textAlign: "center", fontFamily: F.sans, fontWeight: 300, fontSize: 290, color: "#fff", letterSpacing: -6 }}>3:12</div>
    <div style={{ position: "absolute", top: 640, left: 50, right: 50, display: "flex", flexDirection: "column", gap: 26 }}>
      {NOTES.map((n, i) => (
        <div key={i} style={{ display: "flex", gap: 34, alignItems: "center", padding: "38px 40px", borderRadius: 56, background: "rgba(60,64,76,0.72)", border: "1px solid rgba(255,255,255,0.12)" }}>
          <Icon app={n.app} />
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: F.sans, fontSize: 36, color: "rgba(255,255,255,0.6)" }}><span>{n.app}</span><span>now</span></div>
            <div style={{ fontFamily: F.sans, fontWeight: 700, fontSize: 52, color: "#fff", marginTop: 4 }}>{n.title}</div>
            <div style={{ fontFamily: F.sans, fontSize: 42, color: "rgba(255,255,255,0.7)", marginTop: 4 }}>{n.body}</div>
          </div>
        </div>
      ))}
    </div>
  </AbsoluteFill>
);

const Bub: React.FC<{ who?: string; av?: 0 | 1; me?: boolean; children: React.ReactNode }> = ({ who, av = 0, me, children }) => (
  <div style={{ display: "flex", gap: 22, alignItems: "flex-end", justifyContent: me ? "flex-end" : "flex-start" }}>
    {me ? null : <Avatar n={av} size={86} />}
    <div>
      {who ? <div style={{ fontFamily: F.sans, fontSize: 34, color: C.muted, margin: "0 26px 8px" }}>{who}</div> : null}
      <div style={{ padding: "28px 40px", borderRadius: 52, background: me ? "#0A84FF" : "#26272B", fontFamily: F.sans, fontSize: 50, lineHeight: 1.25, color: "#fff", maxWidth: 860 }}>{children}</div>
    </div>
  </div>
);

const Pill: React.FC<{ back?: boolean; children: React.ReactNode }> = ({ back, children }) => {
  const col = back ? C.up : C.fade;
  return <div style={{ alignSelf: "center", padding: "14px 32px", borderRadius: 999, background: `${col}22`, border: `2px solid ${col}66`, fontFamily: F.mono, fontSize: 36, color: col }}>{back ? "▲" : "▼"} {children}</div>;
};

/** The group chat: his take shared, backs and fades, "everyone's copy trading you on X". */
export const ChatScreen: React.FC = () => (
  <AbsoluteFill style={{ background: "#000" }}>
    <Status />
    <div style={{ position: "absolute", top: 150, left: 0, right: 0, paddingBottom: 30, textAlign: "center", borderBottom: "2px solid rgba(255,255,255,0.1)" }}>
      <div style={{ display: "flex", justifyContent: "center" }}><Avatar n={0} size={100} /><div style={{ marginLeft: -30 }}><Avatar n={1} size={100} /></div></div>
      <div style={{ fontFamily: F.sans, fontWeight: 700, fontSize: 46, color: "#fff", marginTop: 12 }}>the boys 🏀</div>
    </div>
    <div style={{ position: "absolute", top: 420, left: 44, right: 44, display: "flex", flexDirection: "column", gap: 34 }}>
      <Bub who="Kai">
        yo is this ur take??
        <div style={{ marginTop: 20, borderRadius: 36, overflow: "hidden", background: "#0F1014", border: "2px solid rgba(255,255,255,0.1)", width: 760 }}>
          <div style={{ padding: 32, display: "flex", gap: 28, alignItems: "center" }}>
            <Donut weights={PICKS.map((p) => p.w)} size={170} stroke={22} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: F.serif, fontSize: 46, lineHeight: 1.1 }}>Everyone is betting on everything</div>
              <div style={{ display: "flex", gap: 12, marginTop: 16 }}>{PICKS.map((p) => <Brand key={p.k} k={p.k} size={54} />)}</div>
            </div>
          </div>
          <div style={{ display: "flex" }}>
            <div style={{ flex: 1, padding: "22px 0", textAlign: "center", fontWeight: 700, fontSize: 40, color: "#06210F", background: "#A6E3B8" }}>Back it</div>
            <div style={{ flex: 1, padding: "22px 0", textAlign: "center", fontWeight: 700, fontSize: 40, color: "#3A0A1C", background: "#F3B6CC" }}>Fade it</div>
          </div>
        </div>
      </Bub>
      <Pill back>Maya backed your take · $50</Pill>
      <Pill>Dre faded your take · $20</Pill>
      <Bub who="Kai">BRO hella ppl copy trading u on X 😭</Bub>
      <Bub who="Dre" av={1}>ok unfading 💀</Bub>
      <Pill back>Dre backed your take · $100</Pill>
      <Bub me>told y'all</Bub>
    </div>
  </AbsoluteFill>
);

/**
 * The lock screen composited onto the blank phone in the copy-trading shot (s4x): light, so it matches
 * the white glow the screen throws on his face; notifications stack in one after another, big enough
 * to read at the size the phone is in frame.
 */
export const PHONE_UI = { w: 600, h: 1170, frames: 66, fps: 24 };
/* What the app really sends (supabase notifications: "@x traded your take · $N" with the claim as the body;
   badges: "You earned a badge: …" / "Non-transferable, on-chain."), laid out like an iOS lock screen. */
const LOCK: { app: "THESIS" | "X"; title: string; body: string }[] = [
  { app: "THESIS", title: "@kai traded your take · $250", body: "Everyone is betting on everything" },
  { app: "X", title: "macro mike", body: "copying @dev on this one 👀 the house always wins" },
  { app: "THESIS", title: "You earned a badge: First take at +100%", body: "Non-transferable, on-chain." },
];
const AppIcon: React.FC<{ app: "THESIS" | "X"; size: number }> = ({ app, size }) =>
  app === "THESIS" ? (
    <Img src={staticFile("img/appicon.png")} style={{ width: size, height: size, borderRadius: size * 0.225, flexShrink: 0 }} />
  ) : (
    <div style={{ width: size, height: size, borderRadius: size * 0.225, flexShrink: 0, background: "#000", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "-apple-system, Helvetica, sans-serif", fontWeight: 700, fontSize: size * 0.58 }}>𝕏</div>
  );

export const PhoneUI: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sf = "-apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif";
  return (
    <AbsoluteFill style={{ background: "radial-gradient(120% 70% at 30% 10%, #9DB8FF 0%, #6E7FE0 35%, #3B2F8F 70%, #1E1748 100%)", fontFamily: sf }}>
      {/* status bar */}
      <div style={{ position: "absolute", top: 26, left: 44, right: 40, display: "flex", justifyContent: "space-between", color: "#fff", fontSize: 24, fontWeight: 600 }}>
        <span>Verizon</span>
        <span style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
          <span style={{ display: "flex", alignItems: "flex-end", gap: 3 }}>{[10, 14, 18, 22].map((h) => <span key={h} style={{ width: 5, height: h, borderRadius: 1.5, background: "#fff" }} />)}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span style={{ width: 40, height: 20, borderRadius: 6, border: "2px solid rgba(255,255,255,0.6)", padding: 2, boxSizing: "border-box" }}><span style={{ display: "block", width: "78%", height: "100%", borderRadius: 3, background: "#fff" }} /></span>
            <span style={{ width: 3, height: 7, borderRadius: 1, background: "rgba(255,255,255,0.6)" }} />
          </span>
        </span>
      </div>
      {/* date + time */}
      <div style={{ position: "absolute", top: 92, width: "100%", textAlign: "center", color: "rgba(255,255,255,0.92)", fontSize: 30, fontWeight: 600 }}>Friday, November 20</div>
      <div style={{ position: "absolute", top: 118, width: "100%", textAlign: "center", color: "#fff", fontSize: 168, fontWeight: 700, letterSpacing: -4, lineHeight: 1 }}>3:12</div>
      {/* notifications */}
      <div style={{ position: "absolute", top: 380, left: 16, right: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {LOCK.map((n, i) => {
          const s = spring({ frame: f - (3 + i * 15), fps, config: { damping: 16, mass: 0.7 } });
          return (
            <div key={i} style={{ opacity: Math.min(1, s * 1.4), transform: `translateY(${(1 - s) * -50}px) scale(${0.92 + 0.08 * s})`, display: "flex", gap: 18, alignItems: "flex-start", padding: "22px 22px", borderRadius: 34, background: "rgba(245,245,250,0.78)", boxShadow: "0 6px 20px rgba(0,0,0,0.12)" }}>
              <AppIcon app={n.app} size={70} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                  <div style={{ fontSize: 31, fontWeight: 700, lineHeight: 1.15, color: "#111" }}>{n.title}</div>
                  <div style={{ fontSize: 22, color: "rgba(0,0,0,0.45)", flexShrink: 0 }}>now</div>
                </div>
                <div style={{ fontSize: 28, lineHeight: 1.2, color: "rgba(0,0,0,0.78)", marginTop: 3 }}>{n.body}</div>
              </div>
            </div>
          );
        })}
        {/* the pile behind them */}
        {(() => {
          const s = spring({ frame: f - 48, fps, config: { damping: 16 } });
          return (
            <div style={{ opacity: s, transform: `scale(${0.95 + 0.05 * s})`, alignSelf: "center", marginTop: 6, padding: "10px 24px", borderRadius: 999, background: "rgba(255,255,255,0.35)", color: "#fff", fontSize: 24, fontWeight: 600 }}>
              +125 more from Thesis
            </div>
          );
        })()}
      </div>
      {/* flashlight / camera */}
      {[60, 600 - 60 - 76].map((x, i) => (
        <div key={i} style={{ position: "absolute", bottom: 60, left: x, width: 76, height: 76, borderRadius: 38, background: "rgba(0,0,0,0.28)" }} />
      ))}
      <div style={{ position: "absolute", bottom: 20, left: 200, width: 200, height: 8, borderRadius: 4, background: "rgba(255,255,255,0.9)" }} />
    </AbsoluteFill>
  );
};
