import type { NextConfig } from "next";

// Server-side setting: where the fork Blink runs. Without it the Blink routes below don't exist.
const FORK_BLINK_URL = process.env.FORK_BLINK_URL?.replace(/\/$/, "");

// On every response. Thesis holds a wallet, so no other site may frame it (clickjacking): the CSP
// directive and the older header both say so. Only frame-ancestors for now: a full script/connect
// CSP has to allow Privy's iframe, scripts and RPC hosts, and waits until it's tested with sign-in.
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const config: NextConfig = {
  // The link-preview images read their fonts and the bundled avatar faces from disk.
  outputFileTracingIncludes: {
    "/c/[id]/og": ["./app/fonts/*.ttf", "./public/avatars/*.png"],
    "/u/[handle]/opengraph-image": ["./app/fonts/*.ttf", "./public/avatars/*.png"],
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    // (The browser reaches the fork API through app/api/fork, a server route that adds the abuse guard's proxy headers.)
    if (!FORK_BLINK_URL) return [];
    return [
      // Solana Actions (Blinks) for the same share URLs, served by the fork Blink.
      { source: "/actions.json", destination: `${FORK_BLINK_URL}/actions.json` },
      { source: "/api/actions/:path*", destination: `${FORK_BLINK_URL}/api/actions/:path*` },
    ];
  },
};

export default config;
