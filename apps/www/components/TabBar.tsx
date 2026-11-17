"use client";
// The iOS app's tab bar: Home, Scores and Me in a glass capsule, with Search as the separate round
// button, and "What's your take?" above it to start a new take (signed in). Take and called-it pages
// have their own trade dock at the bottom, so they don't show it.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { useComposer } from "./Composer";
import { HomeIcon, PersonIcon, SearchIcon, TrophyIcon } from "./Icons";

const TABS = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/scores", label: "Scores", Icon: TrophyIcon },
  { href: "/me", label: "Me", Icon: PersonIcon },
];

export default function TabBar() {
  const path = usePathname() ?? "/";
  const { phase } = useSession();
  const composer = useComposer();
  if (path.startsWith("/t/") || path.startsWith("/c/")) return null;
  // The tabs sit behind the welcome screen and onboarding until you're set up (public profiles keep it).
  const tabRoute = path === "/" || ["/scores", "/me", "/search", "/asset", "/saved", "/people", "/settings", "/x"].some((t) => path === t || path.startsWith(`${t}/`));
  if (phase.kind === "onboarding" || (tabRoute && phase.kind !== "ready")) return null;
  const on = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <nav className="tabbar" aria-label="Tabs">
      {phase.kind === "ready" ? (
        <button className="newtake glass" onClick={() => composer.open()}>
          <span className="orb" aria-hidden />
          <span className="muted">What&apos;s your take?</span>
          <span className="newtake-go" aria-hidden>→</span>
        </button>
      ) : null}
      <div className="tabs glass">
        {TABS.map(({ href, label, Icon }) => (
          <Link key={href} href={href} className="tab" aria-current={on(href) ? "page" : undefined}>
            <Icon />
            {label}
          </Link>
        ))}
      </div>
      <Link href="/search" className="search-btn glass" aria-label="Search" aria-current={on("/search") || on("/asset") ? "page" : undefined}>
        <SearchIcon />
      </Link>
    </nav>
  );
}
