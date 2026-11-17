"use client";
// The iOS PerformanceChart: a line with a soft fill, scrubbable (drag or hover to read a value;
// the number above follows the finger through `onScrub`).
import { useRef } from "react";

export default function Chart({ values, height = 120, onScrub, scrub }: { values: number[]; height?: number; scrub: number | null; onScrub: (i: number | null) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const w = 400;
  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 8;
  const x = (i: number) => (n <= 1 ? w : (i / (n - 1)) * w);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  const up = values[n - 1] >= values[0];
  const color = up ? "var(--up)" : "var(--down)";

  function pick(clientX: number) {
    const box = ref.current?.getBoundingClientRect();
    if (!box || n < 2) return;
    const i = Math.round(((clientX - box.left) / box.width) * (n - 1));
    onScrub(Math.max(0, Math.min(n - 1, i)));
  }

  return (
    <svg
      ref={ref}
      className="chart"
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); pick(e.clientX); }}
      onPointerMove={(e) => (e.buttons || e.pointerType === "mouse") && pick(e.clientX)}
      onPointerUp={() => onScrub(null)}
      onPointerLeave={() => onScrub(null)}
      role="img"
      aria-label="Portfolio over time"
    >
      <defs>
        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${w} ${height}L0 ${height}Z`} fill="url(#chart-fill)" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {scrub != null && n > 1 ? (
        <line x1={x(scrub)} x2={x(scrub)} y1="0" y2={height} stroke="var(--muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="3 3" />
      ) : null}
    </svg>
  );
}
