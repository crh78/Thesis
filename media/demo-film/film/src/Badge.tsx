import React from "react";
import { useCurrentFrame } from "remotion";
import { Mark } from "./Logo";
import { C, F, rand } from "./theme";

export type Tier = { label: string; value?: string; sub: string; rim: string[]; text: string[]; glow: string; logo?: boolean };

export const TIERS: Tier[] = [
  { label: "THESIS", sub: "First take", rim: ["#6B7280", "#F5F7FA", "#9AA0AA", "#FFFFFF", "#6B7280"], text: ["#FFFFFF", "#C9CED6"], glow: "#C9CED6", logo: true },
  { label: "CALLED IT", value: "+50%", sub: "First take", rim: ["#1E7A43", "#A6E3B8", "#E9FFF0", "#97DBAB", "#1E7A43"], text: ["#E9FFF0", "#A6E3B8", "#5FC489"], glow: "#A6E3B8" },
  { label: "CALLED IT", value: "+100%", sub: "First take", rim: ["#8A6420", "#E8C878", "#FFF1C1", "#C9A24A", "#8A6420"], text: ["#FFF6D8", "#E8C878", "#B8892E"], glow: "#E8C878" },
  { label: "CALLED IT", value: "10×", sub: "Ten takes at +50%", rim: ["#5B6CFF", "#8296FF", "#7FF0FF", "#C49BFF", "#5B6CFF"], text: ["#E6FBFF", "#7FF0FF", "#9C8CFF"], glow: "#8296FF" },
  { label: "CALLED IT", value: "+1,000%", sub: "One take", rim: ["#FF7AB6", "#FFD36E", "#7DFFB0", "#6EC8FF", "#B98BFF", "#FF7AB6"], text: ["#FFD36E", "#FF9AC8", "#9FE8FF", "#B98BFF"], glow: "#FF9AC8" },
];

const HEX = "polygon(50% 0%, 93.3% 25%, 93.3% 75%, 50% 100%, 6.7% 75%, 6.7% 25%)";

/** A minted, hexagonal "called it" medallion: turning metallic rim, dark pixel face, gradient value, light sweep. */
export const Badge: React.FC<{ tier: Tier; size: number; seed: number; shine: number }> = ({ tier, size, seed, shine }) => {
  const f = useCurrentFrame();
  const spin = (f * 1.6 + seed * 70) % 360;
  const sweep = -40 + shine * 180;
  const inset = (n: number): React.CSSProperties => ({ position: "absolute", left: n, top: n * 1.1, right: n, bottom: n * 1.1, clipPath: HEX });
  return (
    <div style={{ position: "relative", width: size, height: size * 1.12 }}>
      {/* glow */}
      <div style={{ position: "absolute", inset: -size * 0.12, borderRadius: "50%", background: `radial-gradient(circle, ${tier.glow}40, transparent 62%)`, opacity: 0.6 + 0.4 * Math.sin(f / 12 + seed) }} />
      {/* rim */}
      <div style={{ ...inset(0), background: `conic-gradient(from ${spin}deg, ${tier.rim.join(", ")})` }} />
      <div style={{ ...inset(size * 0.035), background: "#05060A" }} />
      {/* face */}
      <div style={{ ...inset(size * 0.05), background: `radial-gradient(120% 90% at 50% 25%, #1A1D26, #07080B 70%)` }}>
        <div style={{ position: "absolute", inset: 0, opacity: 0.18, backgroundImage: "linear-gradient(rgba(255,255,255,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.12) 1px, transparent 1px)", backgroundSize: `${size / 18}px ${size / 18}px` }} />
      </div>
      {/* inner ring */}
      <div style={{ ...inset(size * 0.1), background: `conic-gradient(from ${-spin}deg, ${tier.rim.join(", ")})`, opacity: 0.55 }} />
      <div style={{ ...inset(size * 0.105), background: `radial-gradient(120% 90% at 50% 25%, #161922, #07080B 70%)` }} />
      {/* content */}
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: size * 0.035 }}>
        <div style={{ fontFamily: F.mono, fontSize: size * 0.05, letterSpacing: size * 0.012, color: C.muted }}>{tier.label}</div>
        {tier.logo ? (
          <div style={{ width: size * 0.36, height: size * 0.36, margin: `${size * 0.01}px 0` }}><Mark size={size * 0.36} /></div>
        ) : (
          <div style={{ fontFamily: F.pixel, fontSize: size * (tier.value!.length > 5 ? 0.15 : 0.2), lineHeight: 1.05, backgroundImage: `linear-gradient(160deg, ${tier.text.join(", ")})`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 0 ${size * 0.03}px ${tier.glow}66)` }}>{tier.value}</div>
        )}
        <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: size * 0.055, color: C.text }}>{tier.sub}</div>
      </div>
      {/* light sweep */}
      <div style={{ ...inset(0), background: `linear-gradient(115deg, transparent ${sweep - 18}%, rgba(255,255,255,0.35) ${sweep}%, transparent ${sweep + 18}%)`, mixBlendMode: "screen" }} />
      {/* sparkles */}
      {Array.from({ length: 5 }, (_, i) => {
        const a = rand(seed * 10 + i) * Math.PI * 2;
        const r = size * (0.52 + rand(seed * 10 + i + 3) * 0.12);
        const tw = Math.max(0, Math.sin(f / 7 + i * 1.9 + seed));
        return <div key={i} style={{ position: "absolute", left: size / 2 + Math.cos(a) * r - 6, top: size * 0.56 + Math.sin(a) * r - 6, width: 12, height: 12, opacity: tw, background: tier.glow, clipPath: "polygon(50% 0, 60% 40%, 100% 50%, 60% 60%, 50% 100%, 40% 60%, 0 50%, 40% 40%)" }} />;
      })}
    </div>
  );
};
