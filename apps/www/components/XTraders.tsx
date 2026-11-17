"use client";
// X accounts you copy: their avatar, and the "Traders on X" row on Search (the app's XTradersRow),
// which opens Copy from X.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";

export type XCall = { post_id: string; url: string; text: string; posted_at: string; claim: string; risk: string | null; horizon: string | null };
export type XAccount = { handle: string; username: string; name: string | null; avatar_url: string | null; calls: XCall[] };

export function XAvatar({ account, size }: { account: Pick<XAccount, "username" | "avatar_url">; size: number }) {
  return (
    <span className="xavatar" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {account.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={account.avatar_url} alt="" />
      ) : account.username.slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function XTradersRow() {
  const { source } = useSession();
  const [accounts, setAccounts] = useState<XAccount[] | null>(null);
  useEffect(() => {
    source<{ accounts: XAccount[] }>("GET", "x").then((r) => setAccounts(r.accounts)).catch(() => setAccounts([]));
  }, [source]);
  const list = accounts ?? [];
  return (
    <section className="xtraders">
      <div className="search-sec" style={{ marginTop: 14 }}>
        <h2 className="search-h" style={{ margin: 0 }}>Traders on X</h2>
        <Link href="/x" className="up small" style={{ fontWeight: 600 }}>{list.length ? "See calls" : "Add"}</Link>
      </div>
      <div className="xfaces">
        <Link href="/x" className="xface" aria-label="Copy a trader on X">
          <span className="xadd">+</span>
          <span className="muted small">Copy</span>
        </Link>
        {list.map((a) => (
          <Link key={a.handle} href="/x" className="xface" aria-label={`@${a.username}`}>
            <XAvatar account={a} size={52} />
            <span className="muted small">{a.username}</span>
          </Link>
        ))}
        {accounts != null && list.length === 0 ? <p className="muted small xtraders-hint">Copy traders on X: their calls show up as takes, ready to trade.</p> : null}
      </div>
    </section>
  );
}
