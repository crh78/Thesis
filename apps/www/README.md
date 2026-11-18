# @thesis/www

The public Thesis app (phase 1, web first): a mobile-first, installable web app that looks and works
like the iOS app, so nobody needs the native one. `/t/<take-id>` is a take's page with a link
preview, and anyone can trade or fade it from the browser on the shared fork with play money. Hosted on Vercel (project
`thesis-www`, root directory `apps/www`): **https://thesis-www.vercel.app**, and yourthesis.xyz once
the domain is added to the project.

- **Sign-in:** Google or email (Privy, headless: our own buttons), the same Privy app as iOS, so the same account reaches the same embedded wallet and profile. X too once `NEXT_PUBLIC_X_LOGIN=on` (`lib/flags.ts`; waits on X login being enabled in the Privy dashboard), and then first, so a reply to @thesis maps to the replier's wallet. Signed-out visitors get the welcome screen; take, called-it and profile pages stay public, and Trade opens sign-in in a sheet (`components/SignIn.tsx`).
- **Onboarding** (`components/Onboarding.tsx`, `lib/session.tsx`): the iOS steps (profile with live handle check, photo, where you live, people to follow), drawn over any page until done. Non-X sign-ins are asked once to connect X.
- **Screens, each mirroring iOS:** Home (`components/Feed.tsx`: For you / Following, rows with return, sparkline, allocation bar, Trade / Fade via `?side=`), Scores (own P&L, made for backers, faders; by $ or %; your line pinned), Search (Takes, People, Assets; topic chips and trending when empty), asset pages (chart 1D–1Y, takes holding it), comments (`?comments=1`), notifications, the profile drawer (`components/Drawer.tsx`, with `/saved`, `/people/following|followers`, `/settings`), and Copy from X (`app/(tabs)/x`, through the `source` function's X routes; Copy on a call opens the composer drafted).
- **New take** (`components/Composer.tsx`, `lib/compose.ts`): write → risk (no horizon: a take runs until its author sells their buy-in, a year at most) → the take builder's basket (`/api/take-builder`) → edit (risk switch, "Change something…", weights, add/remove) → buy in and post. Posting is the social function's `POST takes` with `await_chain`, then the fork API's publish; the screen waits for the chain to make it live, else Retry or Discard.
- **Me** (`app/(tabs)/me`): both scores, the portfolio chart, cash with Add cash ("$X of $1,000 left to add", from `depositLeftUsd`; no Withdraw), creator fees with Claim all, open positions, your takes (including posting ones) and badges. After a trade it re-checks the portfolio every 5 s for two minutes. Fork calls go through `lib/fork.ts`.
- **Install and push** (`components/AppPrompts.tsx`, `lib/push.ts`, `public/sw.js`): an install prompt once per account on phones; once running from the home screen, a one-time push prompt. New notifications fire a trigger (`*_web_push.sql`) that calls `functions/web-push`. The VAPID public key is in `lib/push.ts`; the private key is a function secret.
- **Trades:** like iOS fork mode: the fork API builds, the Privy wallet signs (`signTransaction`, never sends), the API sends. Back, fade (Phoenix shorts and "No" on prediction legs; card legs left out), sell, add play money.
- **Fork calls** (`lib/fork.ts`): with `NEXT_PUBLIC_FORK_API_URL` set, the browser calls the fork API directly (it allows this site's origin through `FORK_API_CORS_ORIGINS`), so fork reads cost no Vercel function calls; without it, they go through `/api/fork/*`. Either way every call carries the signed-in person's Privy token as `Authorization: Bearer …` (money calls check it; reads count per Privy user instead of per IP), creator fees add `x-thesis-wallet-auth`, a network failure reads "Can't reach Thesis right now", and a 429 says how long to wait from `Retry-After`. A 401 or `wrong_wallet` shows "Sign in again". A split trade that stops partway (`trade_incomplete`, `components/StoppedTrade.tsx`) offers "Finish the trade" while its one retry is left (`POST /wallets/:w/retry`), then "Swap the leftover back to cash" (`POST /wallets/:w/sweep`, then the Phoenix cash-out if it says so); Me lists stopped trades (`GET /wallets/:w/incomplete`) with the same actions, so they can be sorted out after a reload or on another device.
- **Server routes:** `/api/fork/*` proxies the fork API for browsers on a deploy without `NEXT_PUBLIC_FORK_API_URL` (kept for compatibility); the server adds `x-thesis-proxy-key` (`FORK_API_PROXY_KEY`) and `x-thesis-client-ip`, never the browser. Server renders don't use it: they read the fork API at `FORK_API_URL` with the service key. `/api/session` and `/api/social/*` proxy those edge functions for the same reason. `/actions.json` and `/api/actions/*` go to the closed Blink when `FORK_BLINK_URL` is set (otherwise they don't exist).
- **Shell:** the iOS tab bar, palette (system light/dark) and Geist fonts. No play-money or fork labels beyond one quiet line on the welcome screen. On desktop, the phone column centered with a QR code for the current page (`components/DesktopPanel.tsx`). `app/manifest.ts` and `app/apple-icon.png` for home-screen installs; `opengraph-image.tsx` draws link previews.

```sh
cp apps/www/.env.example apps/www/.env.local   # then fill in the values (gitignored)
pnpm --filter @thesis/www dev          # http://localhost:3100 (Privy allows localhost)
vercel deploy --prod                   # from the repo root (.vercel links the project)
```

Privy dashboard: X and Google switched on under Authentication → Socials, with
our own X OAuth client before going public (Privy's default keys are for development), and the
web origins (`http://localhost:3100`, `https://thesis-www.vercel.app`, later yourthesis.xyz) in the
allowed domains.

Settings (`.env.example` lists them; locally in `apps/www/.env.local`, in Vercel as project
environment variables). None has a default, and the build succeeds without them: a missing one
fails the request that needs it with an error naming it.

- Required, client (inlined at build time, so set them before building): `NEXT_PUBLIC_PRIVY_APP_ID`
  (the same Privy app as iOS), `NEXT_PUBLIC_SUPABASE_URL` (`https://<project-ref>.supabase.co`),
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- Required, server only: `FORK_API_URL` (`https://<fork-host>`, the fork API behind `/api/fork/*`),
  `FORK_API_PROXY_KEY` (the secret the fork API shares with this proxy, the same value as the VM's;
  without it the fork API counts every web visitor as Vercel's IP), `FORK_API_SERVICE_KEY` (a
  fork API service key, the secret of a `web=<secret>` entry in the VM's `FORK_API_SERVICE_KEYS`;
  the take, profile and link-preview pages send it on their own receipt reads, so server renders
  aren't rate-limited as one Vercel IP. Server only: a service key may act for any wallet).
- Optional: `NEXT_PUBLIC_FORK_API_URL` (client, inlined at build time; `https://<fork-host>`, the
  same host as `FORK_API_URL`): the browser calls the fork API directly instead of through
  `/api/fork/*`, which saves a Vercel function call per fork request (Hobby allows 1M a month).
  Add this site's origins to the VM's `FORK_API_CORS_ORIGINS` first, then set it and redeploy;
  unset it to go back to the proxy. `FORK_BLINK_URL` (server; `https://<fork-host>:8443`, the fork Blink; without it
  `/actions.json` and `/api/actions/*` don't exist), `NEXT_PUBLIC_X_LOGIN` (`on` once X login is
  enabled in Privy), `NEXT_PUBLIC_X_BOT_HANDLE` (the X bot the screens name; defaults to
  `yourthesisxyz` in `lib/flags.ts`), `NEXT_PUBLIC_SITE_URL` (defaults to Vercel's production URL),
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (defaults to the key in `lib/push.ts`).

Adding yourthesis.xyz: buy it, then `vercel domains add yourthesis.xyz thesis-www` and point its DNS
at Vercel. If the Privy dashboard restricts allowed domains, add the new origin there.
