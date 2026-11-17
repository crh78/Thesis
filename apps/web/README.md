# Thesis Blink

> **Closed:** Solana Blinks appear to be discontinued, so the Blink isn't pursued until that changes. The code and the VM's Blink service stay, unmaintained; the VM's listener is off (`FORK_BLINK_PORT=`). The X surface is now the X reply agent (README, "What's next").

What it does: a Solana Action and browser checkout per take, served by the fork API. The buyer's own wallet signs one transaction with up to three spot or yield legs (through the fork API's Jupiter and Jupiter Lend routing), the proof-of-trade instructions and the Thesis receipt. When the routes don't fit 1,232 bytes it drops its lightest leg and leaves the rest to the app; the Action lists omitted legs. Verified on the fork in Chrome over loopback and HTTPS, including replay and tamper refusals; the take link opens the iOS receipt (`yourthesis-dev://take/<take-id>`).

## Run it on a fork

```sh
pnpm --filter @thesis/web build
FORK_BLINK_PORT=18902 pnpm fork:api
pnpm fork:blink http://127.0.0.1:18902/api/actions/back/<take-id>   # acts as the wallet
```

- `http://127.0.0.1:18902/take/<take-id>` is the checkout page. It needs a wallet that can point at the fork's RPC (Backpack, maybe; Phantom can't).
- `/actions.json` maps share URLs to the Action. `GET /api/actions/back/<take-id>` describes it; `POST …?amount=10` with `{"account":"<wallet>"}` returns the transaction.
- The page checks the fork ID, the unsigned transaction and the only signer before asking for a signature, and its relay accepts only the message it built.
- For HTTPS, forward only the Blink port and set `FORK_BLINK_ORIGIN`; keep the Surfpool RPC private.

## Left open when it closed

Production hosting on Thesis's domain, a mainnet Action (program, lookup table, routing, venue eligibility), a browser-extension test, and in-timeline rendering on X (Dialect's registry was unreachable).
