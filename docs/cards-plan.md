# Collector Crypt cards as basket legs

Live on the fork since the cards reset ([`cards-reset.md`](cards-reset.md)).

## Decisions

- **Paper legs.** No card is bought. A card leg's share of the stake is escrowed in full and returned at settlement or a sale, like a Gemini prediction leg; its P&L counts only in the score. The 0.10% fee applies to the whole stake. Every backer holds the author's card at any stake (a $2 share of a $150 card is fine), so one-of-a-kind cards stop mattering.
- **On-chain kind: Card.** `LegKind::Card` gets the prediction legs' escrow (no token delivered) and records prices in dollars. Leg id: `sha256("thesis:card:v1:collector-crypt:<cardId>")`.
- **Which cards.** Any card Collector Crypt indexes with an insured value above 0, from every category (sealed product, watches and Moonbirds included), listed or not, value of any age.
- **Price.** The settler signs the card's **insured value** at entry, sale and the take's 365-day mark, read at or after the moment (rule `card-insured-value`). Insured value is CC's own market estimate (eBay sold listings, alt.xyz and Fanatics sales, a manual check, benchmarked against ALT and Card Ladder). It isn't a list price (asks sit at a median 1.46×) and changes slowly (median 31 days since the last update in a sample), so card legs sold soon after buying often score near 0%.
- **No price at the sale or the 365-day mark** (CC down, card redeemed or burned): the settler retries, then after the grace period the leg settles at 0% and the position is unscored.
- **Fades** exclude card legs, shown before the user confirms (`FadeVia::None` in the program).
- **Venue:** Collector Crypt only.
- **Finding a card:** a live CC search (`/marketplace?search=`) when a basket is built: one request, 0.1–0.5 s, no key, covers all ~197k cards. A picked card gets one `securities` row (`card:<cardId>`) so `take_legs.asset_id` can point at it, and the asset bank then tracks its value. The `search` parameter isn't in CC's docs; if it stops working, baskets are built without cards.
- **When the take builder offers cards:** medium and high risk only. A take about cards can be all cards; any other take gets at most three cards, each at most 20%, never only cards (one card until 2026-11-19). Later: tune the builder so it reliably reaches for the card search on card takes.

## Why real cards were set aside (research)

- CC's marketplace program (`CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr`) sells escrowless USDC listings; `POST /marketplace/buy` returns an unsigned transaction (Core 859 bytes, pNFT 1,131).
- Listings are 63% Core and 37% pNFT. Proof of trade can't count either: a Core asset isn't a token account, and a pNFT account is always frozen. Only the ~0.7% legacy NFTs would pass.
- Offers sit 40–60% under the ask and draw from a shared escrow; the cheapest listing is about $12. CC's buyback pays 85–93% of insured value for some cards.

## API notes

- `GET /marketplace?step=200&cursor=…` pages every card (`listPriceMin=0.000001` for listed only); `GET /cards/publicNft/{id}` reads one, with its insured value and `metadataUpdatedAt`.
- No key needed: 300 requests/min per method per IP, 10× with a `ccsk_` key from CC by email. A `User-Agent` is required; a 429 puts `retryAfter` in the body.
- Docs: <https://docs.collectorcrypt.com/marketplace/api>, <https://docs.collectorcrypt.com/marketplace/program>.
