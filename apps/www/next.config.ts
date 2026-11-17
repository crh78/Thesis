import type { NextConfig } from "next";

// Server-side setting: where the fork Blink runs. Without it the Blink routes below don't exist.
const FORK_BLINK_URL = process.env.FORK_BLINK_URL?.replace(/\/$/, "");

const config: NextConfig = {
  // The link-preview images read their fonts and the bundled avatar faces from disk.
  outputFileTracingIncludes: {
    "/c/[id]/og": ["./app/fonts/*.ttf", "./public/avatars/*.png"],
    "/u/[handle]/opengraph-image": ["./app/fonts/*.ttf", "./public/avatars/*.png"],
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
