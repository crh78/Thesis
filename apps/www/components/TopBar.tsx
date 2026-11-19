"use client";
// The header on pages below the tabs (a take, a profile, an asset, settings…): a back arrow where the
// tabs show their own controls, and the wordmark in the middle, as on Home.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

// The pages visited in this tab, so Back knows whether there's an app page to go back to. Someone
// who opened a shared link has none, and goes Home instead of leaving the app.
const trail: string[] = [];

/** Mounted once (providers): records each page as it's shown. */
export function NavTrail() {
  const path = usePathname();
  useEffect(() => {
    if (trail.length > 1 && trail[trail.length - 2] === path) trail.pop();
    else if (trail[trail.length - 1] !== path) trail.push(path);
  }, [path]);
  return null;
}

export default function TopBar({ right }: { right?: React.ReactNode }) {
  const router = useRouter();
  return (
    <header className="topbar">
      <button className="icon-btn back-btn" aria-label="Back" onClick={() => (trail.length > 1 ? router.back() : router.push("/"))}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
      <Link href="/" className="brand">thesis</Link>
      <div>{right}</div>
    </header>
  );
}
