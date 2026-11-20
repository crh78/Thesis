"use client";
// Copy / Copying on a public profile, for a signed-in visitor who isn't its owner: copying a trader
// auto-backs each new take of theirs ($20, up to 3 a day; change it in Copy trading). Needs trading
// by text (/limits); without it the button opens that screen.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useCopies } from "@/lib/copies";
import { useSession } from "@/lib/session";

export default function CopyButton({ profileId }: { profileId: string }) {
  const router = useRouter();
  const { phase, snapshot } = useSession();
  const me = phase.kind === "ready" ? snapshot?.profile.id ?? null : null;
  const { copies, error, setTrader } = useCopies();
  const [busy, setBusy] = useState(false);
  if (!me || me === profileId || !copies) return null;
  const copying = copies.traders.find((t) => t.trader_id === profileId && t.auto);

  async function copy() {
    if (!copies?.linked) return router.push("/limits");
    setBusy(true);
    await setTrader(profileId, { auto: true }).catch(() => {});
    setBusy(false);
  }

  return (
    <>
      {copying
        ? <Link href="/copy" className="btn ghost">Copying ✓</Link>
        : <button className="btn ghost" disabled={busy} onClick={copy}>{busy ? "Copying…" : "Copy"}</button>}
      {error ? <div className="err small">{error}</div> : null}
    </>
  );
}
