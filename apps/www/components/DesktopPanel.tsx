"use client";
// On a wide screen the app keeps its phone layout, centered, and this sits beside it: a QR code for
// the page you're on, so you can carry on from your phone. CSS hides it below desktop width.
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import encodeQR from "qr";

function path(matrix: boolean[][]): string {
  let d = "";
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
  return d;
}

export default function DesktopPanel() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);

  const qs = search?.toString();
  const url = origin ? `${origin}${pathname ?? "/"}${qs ? `?${qs}` : ""}` : null;
  const qr = useMemo(() => {
    if (!url) return null;
    const m = encodeQR(url, "raw", { ecc: "medium", border: 2 });
    return { size: m.length, d: path(m) };
  }, [url]);

  return (
    <aside className="desk" aria-label="Open on your phone">
      <div className="brand">thesis</div>
      <p>Turn ideas into markets. Thesis is made for your phone: scan to open this page there.</p>
      <div className="qr">
        {qr ? (
          <svg viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label={`QR code for ${url}`}>
            <path d={qr.d} fill="#07080B" />
          </svg>
        ) : null}
      </div>
      <div className="caps">Scan with your camera</div>
    </aside>
  );
}
