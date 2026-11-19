"use client";
// On a take's page, for anyone holding it: share your own P&L on it. Opens the called-it card made
// from your position (/c/<id>?by=<you>&side=…), where you pick a look and share it.
import Link from "next/link";
import { useEffect, useState } from "react";
import { holdingReturn, pct, type Receipt } from "@/lib/data";
import { fork, TRADED_EVENT, useForkWallet } from "@/lib/fork";
import { useSession } from "@/lib/session";
import { ShareIcon } from "./Icons";

export default function PnlShare({ takeId }: { takeId: string }) {
  const { snapshot } = useSession();
  const handle = snapshot?.profile?.handle ?? null;
  const { address } = useForkWallet();
  const [mine, setMine] = useState<{ side: "back" | "fade"; ret: number } | null>(null);

  useEffect(() => {
    if (!address) return;
    const load = () =>
      fork<Receipt>("GET", `/takes/${takeId}?viewer=${address}`)
        .then((r) => {
          const ps = r.viewerPositions ?? [];
          const side = (["back", "fade"] as const).find((s) => holdingReturn(ps, s) != null);
          setMine(side ? { side, ret: holdingReturn(ps, side)! } : null);
        })
        .catch(() => {});
    load();
    window.addEventListener(TRADED_EVENT, load);
    return () => window.removeEventListener(TRADED_EVENT, load);
  }, [address, takeId]);

  if (!mine || !handle) return null;
  return (
    <Link className={`tag ${mine.ret >= 0 ? "tag-up" : "tag-down"}`} href={`/c/${takeId}?by=${handle}&side=${mine.side}`} aria-label={`Share your P&L, ${pct(mine.ret)}`}>
      You {pct(mine.ret)} <ShareIcon className="tag-icon" />
    </Link>
  );
}
