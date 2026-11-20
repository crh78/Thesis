# QuickNode Stream: Thesis program activity

A QuickNode Stream follows Solana mainnet, keeps only successful transactions that call the
Thesis program, and POSTs them to a Supabase webhook. The webhook decodes the Anchor events and
writes them to the database, which drives the live feed and notifications. Until mainnet, the
fork's relay (`pnpm fork:relay`, [`scripts/fork`](../../scripts/fork/README.md#stream-relay--webhook))
runs this same filter and delivers to the same webhook with `network: "solana-mainnet-fork"`.

```
Solana mainnet ──► QuickNode Stream ──► thesis-filter.js ──► POST ──► Supabase webhook ──► chain_events ──► feed / push / iMessage
                   (Block dataset)      (Thesis txs only)            (decodeThesisStream)
```

| File | What it is |
| --- | --- |
| [`thesis-filter.js`](thesis-filter.js) | The filter to paste into QuickNode. Program ID is the constant at the top. |
| [`fixtures/block.json`](fixtures/block.json) | Sample "Block" dataset input (`json` encoding, a v0 transaction, CPI, a failed tx, an unrelated tx) |
| [`fixtures/block-jsonparsed.json`](fixtures/block-jsonparsed.json) | The same block in `jsonParsed` encoding |
| [`fixtures/programs-with-logs.json`](fixtures/programs-with-logs.json) | The same transactions as the "Programs with Logs" dataset |
| [`fixtures/webhook-payload.example.json`](fixtures/webhook-payload.example.json) | What the webhook receives for `block.json` |
| [`packages/chain/src/stream.ts`](../../packages/chain/src/stream.ts) | `decodeThesisStream` and `thesisEventToJson`, the reference decoding |
| [`fixtures/webhook-events.expected.json`](fixtures/webhook-events.expected.json) | The events the webhook stores for `webhook-payload.example.json` |
| [`supabase/functions/quicknode-stream`](../../supabase/functions/quicknode-stream) | The webhook |

The fixtures are Thesis-like transactions with real Anchor-encoded events and synthetic, round
slot, block height and block time values (`fixtures/fork-logs-notifications.json` is a real fork
recording, with its slots, block times and horizon end replaced the same way). `packages/chain/test/stream.test.ts`
runs the filter on them in a QuickNode-like sandbox and decodes the result, and fails if the filter's
instruction table or program ID drifts from the IDL. Regenerate them after an IDL change with
`node packages/chain/test/stream-fixtures.ts`.

## What the filter does

For every transaction in the batch:

1. Drops failed transactions (`meta.err` set, or `success: false` in Programs with Logs).
2. Keeps it if Thesis is invoked anywhere: a top-level instruction, an inner (CPI) instruction,
   including program IDs loaded from address lookup tables, or a `Program <id> invoke [n]` log line.
3. Names the Thesis instructions by their 8-byte Anchor discriminator (`create_take`, `back`,
   `settle_position`, ...; `unknown` if not in the table).
4. Collects the program's events into `events` (base64: discriminator ++ borsh). The program emits
   them with `emit_cpi!` as inner Thesis instructions starting with Anchor's event tag
   (`e4 45 a5 2e 51 cb 9a 1d`), so the validator's 10 KB log limit can't drop them, and only Thesis
   can sign as its event authority.
5. Trims the logs to `invoke` / `success` / `failed` lines plus what Thesis itself logged (older
   transactions carry their events there as `Program data:` lines, which the decoders still read).

It returns `null` (nothing delivered) when a batch has no Thesis transactions, otherwise:

```json
{
  "programId": "HbuuheBxMwf3FVwPYgqzTYdC3uHxqAQCky16rem4wbVe",
  "network": "solana-mainnet",
  "batchStart": 380000000,
  "batchEnd": 380000001,
  "blocksReorged": null,
  "transactions": [
    {
      "signature": "yyzutUEmj8YVT5qkMSfb8k2EfAhjEFMDrsVngcv4EwX2zHYdKpSNDPrKG3qKdy1JZdZKi7ywiR7TNYj4E2iCTiq",
      "slot": 380000000,
      "blockTime": 1800000000,
      "instructions": ["create_take"],
      "events": ["WC8jRqTS…", "…"],
      "logs": ["Program HbuuheBxMwf3FVwPYgqzTYdC3uHxqAQCky16rem4wbVe invoke [1]", "Program log: Instruction: CreateTake", "…"]
    }
  ]
}
```

`logsTruncated: true` marks a transaction whose logs the validator cut; its `events` are complete anyway.

## Cost and plan

Streams bills per block (slot) processed, not per delivery, and filters don't change that
([billing](https://www.quicknode.com/docs/streams/billing)). From the billing calculator:

| | |
| --- | --- |
| Solana `block` or `programs_with_logs` | **30 API credits per slot** |
| Following the tip for a month | ~12.96M slots, **~389M credits** |
| Free trial (10M credits/month) | ~333k slots, about **37 hours** of tip streaming |
| Build, $49/month (80M credits) | about **12 days** of tip streaming |

Credits are shared with RPC calls on the same account. Plan limits that matter here
([pricing](https://www.quicknode.com/pricing),
[Solana Streams guide](https://www.quicknode.com/guides/quicknode-products/streams/how-to-stream-solana-program-data)):
the free trial allows one Solana Stream, webhook destinations only, and only from the chain tip
(no start slot, no backfill). Build and up add a start slot and backfill, PostgreSQL destinations,
gzip and "Restream on reorg".

**To save credits:** create the Stream paused, activate it for testing windows, and pause it
otherwise. When resuming, "resume from latest block" skips paying for the gap (events in
the gap are then missing from the feed; on a paid plan, a backfill over that slot range fills them).

## Create the Stream (dashboard)

Before you start: deploy the program to mainnet, and have the Supabase webhook URL and its
security-token secret ready (see the Supabase section below). Docs:
[Streams overview](https://www.quicknode.com/docs/streams),
[Solana data source](https://www.quicknode.com/docs/streams/data-sources/solana),
[filters](https://www.quicknode.com/docs/streams/filters),
[webhook destination](https://www.quicknode.com/docs/streams/destinations/webhooks).

1. Open [dashboard.quicknode.com](https://dashboard.quicknode.com) → **Streams** → **+ New Stream**.
2. **Name:** `thesis-mainnet`. **Chain:** Solana. **Network:** Mainnet.
3. **Start:** latest block (free trial), or on a paid plan the slot of the program's deploy
   transaction so nothing is missed. **End:** none (follow the tip).
4. **Dataset:** **Block**. ("Programs with Logs" costs the same and the filter handles it too, but
   Block is the documented `getBlock` shape and has inner instructions.)
5. **Batch size:** 5 or more with **Elastic batch** on. Solana slots are under a second, and tip
   Streams on such chains must batch at least 5 blocks; elastic batch still delivers as soon as
   blocks arrive ([batch size](https://www.quicknode.com/docs/streams/rest-api#batch-size-and-elastic-batch)).
   **Restream on reorg:** on, if the plan has it.
6. **Customize your payload** → JavaScript → paste all of [`thesis-filter.js`](thesis-filter.js).
7. **Test the filter.** Until Thesis has transactions on mainnet, any test block returns `null`.
   To see real output, temporarily change `THESIS_PROGRAM_ID` to a busy Anchor program such as
   Jupiter (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`), run the test on a recent slot, then
   **change it back** before saving. Instruction names will read `unknown` for other programs.
   After launch, test on the slot of a real Thesis transaction and check `slot` is filled in.
8. **Destination:** **Webhook**.
   - **URL:** the Supabase function, e.g. `https://<project-ref>.supabase.co/functions/v1/quicknode-stream`.
   - **Compression:** None (or Gzip if the endpoint inflates it).
   - **Timeout:** 30s. **Retry every:** 1s. **Pause after:** 3 failed retries (the defaults).
   - **Custom headers:** if the function keeps Supabase's JWT check on, add
     `Authorization: Bearer <anon key>`. Otherwise deploy it with `--no-verify-jwt` and rely on the
     HMAC check below.
   - **Security token:** copy it into the Supabase secret `QUICKNODE_STREAM_TOKEN`.
   - Add a notification email so you hear about a paused Stream.
   - **Check Connection**, then **Create a Stream** (create it paused if you're not demoing yet).

With a Streams API key instead of the dashboard
([create stream](https://www.quicknode.com/docs/streams/rest-api/create-stream),
[test filter](https://www.quicknode.com/docs/streams/rest-api/test-filter)):

```sh
FILTER=$(base64 < infra/quicknode/thesis-filter.js | tr -d '\n')

# Try the filter on one slot.
curl -X POST https://api.quicknode.com/streams/rest/v1/streams/test_filter \
  -H "x-api-key: $QN_STREAMS_API_KEY" -H "Content-Type: application/json" \
  -d "{\"network\":\"solana-mainnet\",\"dataset\":\"block\",\"filter_function\":\"$FILTER\",\"block\":\"<slot>\"}"

# Create the Stream, paused.
curl -X POST https://api.quicknode.com/streams/rest/v1/streams \
  -H "x-api-key: $QN_STREAMS_API_KEY" -H "Content-Type: application/json" \
  -d "{
    \"name\": \"thesis-mainnet\",
    \"network\": \"solana-mainnet\",
    \"dataset\": \"block\",
    \"filter_function\": \"$FILTER\",
    \"region\": \"usa_east\",
    \"dataset_batch_size\": 5,
    \"elastic_batch_enabled\": true,
    \"fix_block_reorgs\": 1,
    \"keep_distance_from_tip\": 0,
    \"destination\": \"webhook\",
    \"destination_attributes\": {
      \"url\": \"https://<project-ref>.supabase.co/functions/v1/quicknode-stream\",
      \"compression\": \"none\",
      \"max_retry\": 3,
      \"retry_interval_sec\": 1,
      \"post_timeout_sec\": 30
    },
    \"status\": \"paused\"
  }"
```

Omit `start_range` to start at the tip; `fix_block_reorgs: 1` needs a paid plan.

## The Supabase side (built)

**`supabase/functions/quicknode-stream`** is the webhook:

1. Accepts `POST` with the filter's return value as the body (also wrapped in `{ "data": ... }`).
2. Verifies QuickNode's signature: HMAC-SHA256 keyed with the Stream's security token
   (`QUICKNODE_STREAM_TOKEN`), over `X-QN-Nonce + X-QN-Timestamp + <raw body>`, hex, compared in
   constant time with `X-QN-Signature`. Requests older than 5 minutes are refused
   ([guide](https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages)).
3. Decodes the events (`decode.ts`: Anchor's event parser with a copy of the IDL in
   `functions/_shared/thesis-idl.json`, then the same JSON form as `thesisEventToJson`) and calls
   `ingest_chain_events(network, events)` with the service role. A 5xx makes QuickNode retry.
4. Is idempotent: events are keyed `(network, signature, ordinal)`, so retries and reorg
   re-deliveries store nothing twice and never double-count.

**`supabase/migrations/*_chain_events.sql`:**

- `chain_events`: every decoded event (`name`, `take`, `data` as below), service role only.
- `chain_takes`: one row per on-chain take, with backers, faders, money in and the settled result,
  public. Each row maps to the app's take whose claim hashes (sha256) to the on-chain `claimHash`.
- `take_json()` (every feed card and take page): with an `x-thesis-network` request header, a take
  that's on-chain on that network shows the chain's counts and result. The web app and fork-mode
  iOS builds send `solana-mainnet-fork`.

Tests: `deno test` in the function's folder (the decoding matches `@thesis/chain` on
`fixtures/webhook-events.expected.json`, and the signature check), a `packages/chain` test that the
IDL copy matches, and `supabase/tests/chain_events.sql` for the database side.

Built on it: notifications, posting that waits for `takeCreated`, and on-chain scores, partial sales included
(`chain_positions`, `chain_wallet_stats`). Not yet: iMessage group updates and Realtime for the feed.

**Event `data` as JSON** (`thesisEventToJson`): public keys are base58 strings, `u64`/`i64` are
decimal strings, small ints and `bool` stay as numbers and booleans, enums are their variant name,
and `claimHash` is an array of 32 numbers. USDC amounts are base units (6 decimals); `*Bps` are
basis points.

| `name` | `data` fields |
| --- | --- |
| `takeCreated` | `take`, `author`, `claimHash`, `risk` (`low`/`medium`/`high`), `horizonEnd` (Unix s: posting + 365 days), `legs`, `stake` |
| `positionOpened` | `take`, `position`, `owner`, `side` (`back`/`fade`), `stake`, `legsMask`, `fee`, `creatorFee`, `scored`, `escrowed` (the paper legs' share) |
| `tradeProved` | `position`, `owner`, `spent`, `outputsMask`, `outputs`, `received`: what one proof-of-trade bracket measured |
| `entryPricesRecorded` | `take`, `position`, `legs` (bit mask), `sourceHash` |
| `exitPricesRecorded` | `take`, `position`, `legs`, `sourceHash` (prices at the 365-day mark) |
| `positionExited` | `take`, `position`, `owner`, `side`, `exitedAt` (Unix s), `escrowReturned`, `stake`: the owner sold all of it |
| `positionPartSold` | `take`, `position`, `owner`, `side`, `seq`, `bps`, `stakeSold`, `remainingStake`, `escrowReturned`, `soldAt`: a partial sale |
| `takeClosed` | `take`, `author`, `closedAt` (Unix s): the author sold all of their buy-in, so the take takes no new backs or fades and settles on the sale |
| `salePricesRecorded` | `take`, `position`, `legs`, `sourceHash` (prices at the sale) |
| `partPricesRecorded` | `take`, `position`, `seq`, `legs`, `sourceHash` (prices at a partial sale) |
| `takeSettled` | `take`, `author`, `resultBps` |
| `partSettled` | `take`, `position`, `owner`, `side`, `seq`, `stake`, `returnBps`, `pnl`, `scored` |
| `positionSettled` | `take`, `position`, `owner`, `side`, `returnBps`, `pnl`, `scored`, `exited` (scored at its sale), `escrowReturned`, `stake` |
| `creatorFeesClaimed` | `take`, `author`, `amount` |
| `badgeMinted` | `owner`, `kind`, `mint` |
| `configUpdated` | `admin`, `allowlistAdmin`, `pendingAdmin`, `pendingAllowlistAdmin`, `settler`, `params`, `tradePrograms`, `badgeUriBase` |
| `feesWithdrawn` | `destination`, `amount` |
