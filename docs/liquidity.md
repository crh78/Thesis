# Liquidity registry

_Generated 2026-11-17 18:13:36 UTC by `node packages/venues/registry/src/build.ts`. Do not edit by hand: rerun the script. Machine-readable copy: [`packages/venues/registry/assets.json`](../packages/venues/registry/assets.json)._

Every asset Thesis could put in a basket, with liquidity measured live. Scope: what a user can trade from their own wallet without the issuer's KYC, plus the venues we already use (Phoenix, Kamino, Jupiter Lend, Collector Crypt) and Gemini, which Thesis trades custodially.

## How to read this

- **Buy cost** is a USDC buy quoted live on Jupiter (`https://lite-api.jup.ag/swap/v1/quote`, `maxAccounts=30`, the cap that fits a 3-leg Blink). It is the worst of three numbers, plus any Token-2022 transfer fee: Jupiter's `priceImpactPct`; the slippage against the $10 quote's rate; and the shortfall against Jupiter's USD price for the token (scaled by the token's UI multiplier). Proprietary AMMs and order books often report 0% impact, which is why the other two exist.
- **Class:** tradeable = a $100 USDC buy routes on Jupiter with maxAccounts=30 and costs < 1%, where cost = the worst of Jupiter's priceImpactPct, slippage vs the $10 quote's rate, and the shortfall vs Jupiter's USD price (UI-multiplier adjusted), plus any Token-2022 transfer fee. thin = routes but costs more, or only $10 routes. price-only = no usable route but a Jupiter or Pyth price exists. no-market = neither.
- **Not quoted:** tokens with less than $100 of pooled liquidity in Jupiter's token API (`https://lite-api.jup.ag/tokens/v2/tag?query=verified`) are not quoted, to stay inside the free rate limit. Run with `--quote-floor=0` to quote them too.
- **Pyth:** feed symbols come from the keyless Hermes catalog (`https://hermes.pyth.network/v2/price_feeds`). "free on-chain" means Pyth's sponsored push account on mainnet (shard 0 of the Core or Core-Compatible push program) updated within the last 4 days, which allows for weekends and market close, so any program can read it for free. "push acct stale" means the account exists but stopped updating (most equity feeds have). "key" means pull-only: the signed update must come from Hermes, which needs a Pyth API key (<https://docs.pyth.network/pro/pyth-core-upgrade.mdx>). Each feed's `access` and push account are in `assets.json`.
- **Token:** program, and Token-2022 extensions that matter: transfer fee, permanent delegate (issuer can move or burn your tokens), pausable, scaled UI amount (wallet shows raw amount x multiplier), transfer hook.
- Inputs this run: Jupiter api.jup.ag (JUPITER_API_KEY); RPC QuickNode (QUICKNODE_RPC_URL); keys QUICKNODE_RPC_URL=set JUPITER_API_KEY=set PYTH_API_KEY=empty.

### Gaps this run

- PYTH_API_KEY is empty: Pyth prices were not fetched. Feed IDs come from the keyless Hermes catalog; 'free on-chain' is decided by reading the sponsored push accounts on mainnet.

## Summary

| Category | Assets | Tradeable | Thin | Price-only | No market | Excluded |
|---|---|---|---|---|---|---|
| stock | 2103 | 88 | 90 | 1173 | 752 | 0 |
| pre-ipo | 13 | 3 | 9 | 1 | 0 | 0 |
| leveraged | 8 | 0 | 0 | 8 | 0 | 0 |
| commodity | 6 | 5 | 0 | 1 | 0 | 0 |
| yield-token | 11 | 10 | 0 | 1 | 0 | 0 |
| other-rwa | 1 | 0 | 0 | 0 | 0 | 1 |
| Phoenix perps | 109 | 109 | 0 | 0 | 0 | 0 |

For perps, "tradeable" means a $1,000 taker buy fills within 1% of mid on the live book.

## Spot tokens (Jupiter, user's own wallet)

### Tokenized stocks and ETFs: xStocks

Issuer: xStocks (Backed Finance, owned by Kraken). Not for US persons; issuer also lists Australia, Canada, UK and sanctioned regions as unavailable (Kraken support page). Secondary trading on Jupiter is permissionless on-chain. Issuer holds a permanent delegate (can move or burn any holder's tokens) and a pause authority. Sources: <https://support.kraken.com/articles/xstocks-availability>, <https://assets.backed.fi/>.

1519 assets: 30 tradeable, 33 thin, 763 price-only, 693 with no market.

| Symbol | Name | Mint | Token | Pyth | Buy cost $10 / $100 / $1k | Pooled liq. | Class |
|---|---|---|---|---|---|---|---|
| SPYx | SP500 xStock | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | token-2022, perm. delegate, pausable, UI x1.0075 | `Crypto.SPYX/USD` (free on-chain)<br>`Equity.US.SPY/USD` (push acct stale; key) | 0.01% / 0.01% / 0.03% | $2.6M | **tradeable** |
| NVDAx | NVIDIA xStock | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | token-2022, perm. delegate, pausable, UI x1.0017 | `Crypto.NVDAX/USD` (free on-chain)<br>`Equity.US.NVDA/USD` (push acct stale; key) | 0.08% / 0.09% / 0.10% | $2.2M | **tradeable** |
| TSLAx | Tesla xStock | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` | token-2022, perm. delegate, pausable | `Crypto.TSLAX/USD` (free on-chain)<br>`Equity.US.TSLA/USD` (push acct stale; key) | 0.06% / 0.10% / 0.06% | $1.6M | **tradeable** |
| SPCXx | SpaceX xStock | `Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8` | token-2022, perm. delegate, pausable | `Crypto.SPCXX/USD` (free on-chain)<br>`Equity.US.SPCX/USD` (push acct stale; key) | 0.04% / 0.03% / 0.00% | $1.6M | **tradeable** |
| QQQx | Nasdaq xStock | `Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ` | token-2022, perm. delegate, pausable, UI x1.0035 | `Crypto.QQQX/USD` (free on-chain)<br>`Equity.US.QQQ/USD` (push acct stale; key) | 0.07% / 0.13% / 0.20% | $1.4M | **tradeable** |
| CRCLx | Circle xStock | `XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1` | token-2022, perm. delegate, pausable | `Crypto.CRCLX/USD` (free on-chain)<br>`Equity.US.CRCL/USD` (push acct stale; key) | 0.10% / 0.11% / 0.12% | $881k | **tradeable** |
| MSTRx | MicroStrategy xStock | `XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ` | token-2022, perm. delegate, pausable | `Crypto.MSTRX/USD` (free on-chain)<br>`Equity.US.MSTR/USD` (push acct stale; key) | 0.46% / 0.49% / 0.49% | $735k | **tradeable** |
| AAPLx | Apple xStock | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | token-2022, perm. delegate, pausable, UI x1.0038 | `Crypto.AAPLX/USD` (free on-chain)<br>`Equity.US.AAPL/USD` (push acct stale; key) | 0.02% / 0.07% / 0.15% | $614k | **tradeable** |
| MSFTx | Microsoft xStock | `XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX` | token-2022, perm. delegate, pausable, UI x1.0059 | `Crypto.MSFTX/USD` (push acct stale; key)<br>`Equity.US.MSFT/USD` (push acct stale; key) | 0.14% / 0.14% / 0.21% | $610k | **tradeable** |
| METAx | Meta xStock | `Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu` | token-2022, perm. delegate, pausable, UI x1.0029 | `Crypto.METAX/USD` (free on-chain)<br>`Equity.US.META/USD` (push acct stale; key) | 0.15% / 0.15% / 0.16% | $533k | **tradeable** |
| GLDx | Gold xStock | `Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re` | token-2022, perm. delegate, pausable | `Crypto.GLDX/USD` (free on-chain)<br>`Equity.US.GLD/USD` (push acct stale; key) | 0.02% / 0.08% / 0.06% | $533k | **tradeable** |
| MCDx | McDonald's xStock | `XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2` | token-2022, perm. delegate, pausable, UI x1.0212 | `Crypto.MCDX/USD` (free on-chain)<br>`Equity.US.MCD/USD` (push acct stale; key) | 0.00% / 0.07% / 0.31% | $507k | **tradeable** |
| GMEx | Gamestop xStock | `Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc` | token-2022, perm. delegate, pausable, UI x1.0053 | `Equity.US.GME/USD` (push acct stale; key) | 0.05% / 0.12% / 0.34% | $432k | **tradeable** |
| GOOGLx | Alphabet xStock | `XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN` | token-2022, perm. delegate, pausable, UI x1.0024 | `Crypto.GOOGLX/USD` (free on-chain)<br>`Equity.US.GOOGL/USD` (push acct stale; key) | 0.10% / 0.00% / 0.04% | $428k | **tradeable** |
| AMZNx | Amazon xStock | `Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg` | token-2022, perm. delegate, pausable | `Crypto.AMZNX/USD` (free on-chain)<br>`Equity.US.AMZN/USD` (push acct stale; key) | 0.19% / 0.19% / 0.19% | $297k | **tradeable** |
| COINx | Coinbase xStock | `Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu` | token-2022, perm. delegate, pausable | `Crypto.COINX/USD` (free on-chain)<br>`Equity.US.COIN/USD` (push acct stale; key) | 0.24% / 0.25% / 0.34% | $238k | **tradeable** |
| AVGOx | Broadcom xStock | `XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo` | token-2022, perm. delegate, pausable, UI x1.0062 | `Equity.US.AVGO/USD` (push acct stale; key) | 0.00% / 0.09% / 0.02% | $198k | **tradeable** |
| PLTRx | Palantir xStock | `XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4` | token-2022, perm. delegate, pausable | `Equity.US.PLTR/USD` (push acct stale; key) | 0.54% / 0.56% / 0.59% | $158k | **tradeable** |
| STRCx | Strategy PP Variable xStock | `Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH` | token-2022, perm. delegate, pausable, UI x1.1035 | `Crypto.STRCX/USD` (push acct stale; key)<br>`Equity.US.STRC/USD` (push acct stale; key) | 0.08% / 0.14% / 0.15% | $150k | **tradeable** |
| KOx | Coca-Cola xStock | `XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ` | token-2022, perm. delegate, pausable, UI x1.0226 | `Equity.US.KO/USD` (push acct stale; key) | 0.26% / 0.49% / 1.46% | $91k | **tradeable** |
| HOODx | Robinhood xStock | `XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg` | token-2022, perm. delegate, pausable | `Crypto.HOODX/USD` (free on-chain)<br>`Equity.US.HOOD/USD` (push acct stale; key) | 0.00% / 0.00% / 0.00% | $71k | **tradeable** |
| BRK.Bx | Berkshire Hathaway xStock | `Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x` | token-2022, perm. delegate, pausable | none | 0.09% / 0.29% / 0.52% | $62k | **tradeable** |
| INTCx | Intel xStock | `XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM` | token-2022, perm. delegate, pausable | `Equity.US.INTC/USD` (key) | 0.31% / 0.39% / 0.44% | $57k | **tradeable** |
| TQQQx | TQQQ xStock | `XsjQP3iMAaQ3kQScQKthQpx9ALRbjKAjQtHg6TFomoc` | token-2022, perm. delegate, pausable, UI x2.0117 | `Equity.US.TQQQ/USD` (key) | 0.24% / 0.50% / 4.48% | $40k | **tradeable** |
| DFDVx | DFDV xStock | `Xs2yquAgsHByNzx68WJC55WHjHBvG9JsMB7CWjTLyPy` | token-2022, perm. delegate, pausable, UI x1.0147 | none | 0.40% / 0.57% / 1.82% | $37k | **tradeable** |
| XOMx | Exxon Mobil xStock | `XsaHND8sHyfMfsWPj6kSdd5VwvCayZvjYgKmmcNL5qh` | token-2022, perm. delegate, pausable, UI x1.0221 | `Equity.US.XOM/USD` (push acct stale; key) | 0.13% / 0.81% / 2.59% | $11k | **tradeable** |
| PEPx | PepsiCo xStock | `Xsv99frTRUeornyvCfvhnDesQDWuvns1M852Pez91vF` | token-2022, perm. delegate, pausable, UI x1.0344 | `Equity.US.PEP/USD` (push acct stale; key) | 0.54% / 0.62% / 1.28% | $10k | **tradeable** |
| CHADx | DeFi Development Corp. Variable Rate Series C Perpetual Preferred xStock | `Xsg8azkTEAmBz4Qbs8iYYhgRkLKSqNo85vcJL68aLMH` | token-2022, perm. delegate, pausable, UI x1.0095 | none | 0.16% / 0.21% / 0.37% | $8k | **tradeable** |
| BMNRx | Bitmine xStock | `XsrBCwaH8c46xiqXBChzobgufRKxQxAWUWbndgBNzFn` | token-2022, perm. delegate, pausable | `Equity.US.BMNR/USD` (key) | 0.00% / 0.58% / 9.05% | $1k | **tradeable** |
| PMx | Philip Morris xStock | `Xsba6tUnSjDae2VcopDB6FGGDaxRrewFCDa5hKn5vT3` | token-2022, perm. delegate, pausable, UI x1.0385 | `Equity.US.PM/USD` (key) | 0.04% / 0.05% / 63.49% | $129 | **tradeable** |
| TSMx | TSMC xStock | `XsafvsGtzFqqHgTnA3aPC83EAMkacU5mcGtcSayhpVV` | token-2022, perm. delegate, pausable, UI x1.0062 | `Equity.US.TSM/USD` (key) | 0.46% / 4.86% / 26.20% | $32k | thin |
| VIDAx | Vida Global xStock | `XsfCC9VL4DamVGNgdJpfLXB3sBVa158Gbx8sh7NzmTk` | token-2022, perm. delegate, pausable | none | 3.03% / 3.32% / 6.11% | $9k | thin |
| UNHx | UnitedHealth xStock | `XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe` | token-2022, perm. delegate, pausable, UI x1.0273 | `Equity.US.UNH/USD` (push acct stale; key) | 1.10% / 1.31% / 3.34% | $7k | thin |
| WMTx | Walmart xStock | `Xs151QeqTCiuKtinzfRATnUESM2xTU6V9Wy8Vy538ci` | token-2022, perm. delegate, pausable, UI x1.0072 | `Equity.US.WMT/USD` (key) | 1.58% / 2.43% / 18.30% | $6k | thin |
| NVOx | Novo Nordisk xStock | `XsfAzPzYrYjd4Dpa9BU3cusBsvWfVB9gBcyGC87S57n` | token-2022, perm. delegate, pausable, UI x1.0371 | `Equity.US.NVO/USD` (push acct stale; key) | 4.02% / 4.51% / 7.45% | $3k | thin |
| CVXx | Chevron xStock | `XsNNMt7WTNA2sV3jrb1NNfNgapxRF5i4i6GcnTRRHts` | token-2022, perm. delegate, pausable, UI x1.0296 | `Equity.US.CVX/USD` (key) | 2.01% / 2.63% / no route | $3k | thin |
| LLYx | Eli Lilly xStock | `Xsnuv4omNoHozR6EEW5mXkw8Nrny5rB3jVfLqi6gKMH` | token-2022, perm. delegate, pausable, UI x1.0061 | `Equity.US.LLY/USD` (push acct stale; key) | 2.03% / 2.64% / no route | $3k | thin |
| PGx | Procter & Gamble xStock | `XsYdjDjNUygZ7yGKfQaB6TxLh2gC6RRjzLtLAGJrhzV` | token-2022, perm. delegate, pausable, UI x1.0263 | `Equity.US.PG/USD` (key) | 0.28% / 1.34% / 34.12% | $2k | thin |
| SKHYx | SK hynix xStock | `XsnhgGRQwhExfS2bmWzR6EYddKGPRGDEjeJsatkmKqU` | token-2022, perm. delegate, pausable, UI x1.0001 | `Equity.US.SKHY/USD` (key) | 2.77% / 8.96% / 35.88% | $2k | thin |
| AZNx | AstraZeneca xStock | `Xs3ZFkPYT2BN7qBMqf1j1bfTeTm1rFzEFSsQ1z3wAKU` | token-2022, perm. delegate, pausable, UI x0.5111 | `Equity.US.AZN/USD` (key) | 1.44% / 2.05% / 7.95% | $2k | thin |
| NFLXx | Netflix xStock | `XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL` | token-2022, perm. delegate, pausable, UI x10 | `Crypto.NFLXX/USD` (push acct stale; key)<br>`Equity.US.NFLX/USD` (key) | 2.02% / 2.27% / 4.19% | $2k | thin |
| AMDx | AMD xStock | `XsXcJ6GZ9kVnjqGsjBnktRcuwMBmvKWh8S93RefZ1rF` | token-2022, perm. delegate, pausable | `Equity.US.AMD/USD` (key) | 1.17% / 1.20% / 1.57% | $2k | thin |
| IBMx | International Business Machines xStock | `XspwhyYPdWVM8XBHZnpS9hgyag9MKjLRyE3tVfmCbSr` | token-2022, perm. delegate, pausable, UI x1.0253 | `Equity.US.IBM/USD` (key) | 19.03% / 20.08% / 29.45% | $2k | thin |
| Vx | Visa xStock | `XsqgsbXwWogGJsNcVZ3TyVouy2MbTkfCFhCGGGcQZ2p` | token-2022, perm. delegate, pausable, UI x1.008 | `Equity.US.V/USD` (key) | 4.41% / 10.98% / 57.89% | $2k | thin |
| ORCLx | Oracle xStock | `XsjFwUPiLofddX5cWFHW35GCbXcSu1BCUGfxoQAQjeL` | token-2022, perm. delegate, pausable, UI x1.0119 | `Equity.US.ORCL/USD` (key) | 1.48% / 1.84% / 4.50% | $1k | thin |
| UBERx | Uber xStock | `XsAsZLF4MmsvS1sDxRMrUz7REjHfwbC9UAMXSRBqgEB` | token-2022, perm. delegate, pausable | `Equity.US.UBER/USD` (key) | 1.60% / 13.73% / 47.99% | $1k | thin |
| JPMx | JPMorgan Chase xStock | `XsMAqkcKsUewDrzVkait4e5u4y8REgtyS7jWgCpLV2C` | token-2022, perm. delegate, pausable, UI x1.0174 | `Equity.US.JPM/USD` (key) | 1.68% / 2.27% / 8.77% | $1k | thin |
| MUx | Micron Technology xStock | `XsQLZycSZ7QnBBdBXQaTbQdiUcbRqjNJgyBGAMzhHav` | token-2022, perm. delegate, pausable, UI x1.0005 | `Crypto.MUX/USD` (key)<br>`Equity.US.MU/USD` (push acct stale; key) | 2.20% / 12.41% / 43.76% | $1k | thin |
| SLVx | iShares Silver Trust xStock | `XsxAd6okt8y1RRK6gNg7iJaqiWNiq5Md5EDf3ZrF2dm` | token-2022, perm. delegate, pausable | `Equity.US.SLV/USD` (key) | 3.75% / 17.82% / 55.71% | $1k | thin |
| LINx | Linde xStock | `XsSr8anD1hkvNMu8XQiVcmiaTP7XGvYu7Q58LdmtE8Z` | token-2022, perm. delegate, pausable, UI x1.0149 | `Equity.US.LIN/USD` (key) | 0.51% / 3.15% / no route | $967 | thin |
| PFEx | Pfizer xStock | `XsAtbqkAP1HJxy7hFDeq7ok6yM43DQ9mQ1Rh861X8rw` | token-2022, perm. delegate, pausable, UI x1.0643 | `Equity.US.PFE/USD` (key) | 16.43% / 18.37% / 81.19% | $966 | thin |
| VTIx | Vanguard xStock | `XsssYEQjzxBCFgvYFFNuhJFBeHNdLWYeUSP8F45cDr9` | token-2022, perm. delegate, pausable, UI x1.0118 | `Equity.US.VTI/USD` (key) | 0.04% / 1.75% / no route | $840 | thin |
| MRVLx | Marvell xStock | `XsuxRGDzbLjnJ72v74b7p9VY6N66uYgTCyfwwRjVCJA` | token-2022, perm. delegate, pausable, UI x1.0018 | `Equity.US.MRVL/USD` (key) | 1.80% / 13.43% / 33.87% | $734 | thin |
| ABTx | Abbott xStock | `XsHtf5RpxsQ7jeJ9ivNewouZKJHbPxhPoEy6yYvULr7` | token-2022, perm. delegate, pausable, UI x1.0218 | `Equity.US.ABT/USD` (key) | 2.11% / 3.64% / 17.50% | $613 | thin |
| AMBRx | AMBRx xStock | `XsaQTCgebC2KPbf27KUhdv5JFvHhQ4GDAPURwrEhAzb` | token-2022, perm. delegate, pausable | none | 8.63% / 20.96% / 38.83% | $486 | thin |
| MAx | Mastercard xStock | `XsApJFV9MAktqnAc6jqzsHVujxkGm9xcSUffaBoYLKC` | token-2022, perm. delegate, pausable, UI x1.0058 | `Equity.US.MA/USD` (key) | 3.88% / 4.04% / 36.64% | $394 | thin |
| SNDKx | Sandisk Corporation xStock | `Xswbpc8UqU6e1j9QZEWCjBMjyvz4twqD7PCy6j2e7jj` | token-2022, perm. delegate, pausable | `Equity.US.SNDK/USD` (push acct stale; key) | 2.13% / 2.12% / 2.19% | $329 | thin |
| ACNx | Accenture xStock | `Xs5UJzmCRQ8DWZjskExdSQDnbE6iLkRu2jjrRAB1JSU` | token-2022, perm. delegate, pausable, UI x1.0344 | `Equity.US.ACN/USD` (key) | 1.10% / 19.61% / 88.58% | $253 | thin |
| HONx | Honeywell xStock | `XsRbLZthfABAPAfumWNEJhPyiKDW6TvDVeAeW7oKqA2` | token-2022, perm. delegate, pausable, UI x1.0034 | `Equity.US.HON/USD` (key) | 44.75% / 45.33% / 82.28% | $200 | thin |
| VTx | Vanguard Total World xStock | `XsEdDDTcVGJU6nvdRdVnj53eKTrsCkvtrVfXGmUK68V` | token-2022, perm. delegate, pausable, UI x1.0116 | `Equity.US.VT/USD` (key) | 54.53% / 55.29% / 85.05% | $185 | thin |
| GSx | Goldman Sachs xStock | `XsgaUyp4jd1fNBCxgtTKkW64xnnhQcvgaxzsbAq5ZD1` | token-2022, perm. delegate, pausable, UI x1.0158 | `Equity.US.GS/USD` (key) | 0.25% / 20.59% / 34.51% | $160 | thin |
| MRNAx | Moderna xStock | `XsViHjyRbiSBskjizb1gszGTmZqtAH8TuqwJ7sB5AcP` | token-2022, perm. delegate, pausable | `Equity.US.MRNA/USD` (key) | 99.90% / 99.90% / 99.90% | $128 | thin |
| XLEx | Energy Select Sector SPDR Fund xStock | `Xs54CrhmpVp6uxZXwgSTegrRH2kShh88XFPzgf4BExu` | token-2022, perm. delegate, pausable, UI x1.0092 | `Equity.US.XLE/USD` (key) | 64.04% / 64.04% / 88.73% | $113 | thin |

- **Price-only (763):** CMCSAx, BACx, CSCOx, XOPx, CBRSx, IJRx, IWMx, CRMx, HDx, MRKx, KRAQx, TMOx, MDTx, XIAOx, ASTSx, SBETx, SGOVx, SPCEx, CRWDx, ASMLx, RIOTx, APPx, MMMx, JNJx, URAx, BSPx, Fx, NOWx, KLACx, CRWVx, CEGx, BOTx, PWRx, VUGx, SHAZx, EWYx, APLDx, LITEx, WENx, NETx, RBLXx, AMATx, REGNx, ADBEx, BEx, LRCXx, GEVx, TTWOx, ALABx, VRTx, OKLOx, SMCIx, GLXYx, WBDx, IEMGx, NBISx, MARAx, PANWx, ABBVx, ANETx, and 703 more (see `assets.json`).
- **No market (693):** TBLLx, MOOx, CNHx, TNLx, YETIx, TEFx, ARWRx, WUXIBx, HAYWx, ORA.FRx, GLENx, KNEBVx, CAPRx, IMIx, REXRx, SNBIOx, AGNCx, PROKx, PCTx, POPMTx, CACCx, QYLDx, CLONPx, VIAVx, SBRYx, WBSx, GEELx, SWPRPx, SAMPOx, TIGOx, KUNLx, MUSAx, TKRx, DHLx, GTMx, DOXx, DLBx, EL.FRx, OGEx, CROXx, MNDIx, ICBCx, AMS.ESx, SGOx, UCB.BEx, SMOIHx, JACKx, RTOx, DB1x, Sx, CRBGx, ENSGx, CSIQx, FRPTx, RITMx, BAMIx, SZIGHx, IMAXx, VIRTx, PUB.FRx, and 633 more (see `assets.json`).


### Tokenized stocks and ETFs: Ondo Global Markets

Issuer: Ondo Global Markets. Ondo's mint/redeem is geo-restricted and excludes US persons (unverified against Ondo's own terms). Secondary trading on Jupiter is permissionless on-chain. Issuer holds a pause/freeze authority; no permanent delegate. Sources: <https://solana.com/news/ondo-global-markets-tokenized-stocks-etfs-solana>, <https://www.coingecko.com/en/coins/nvidia-ondo-tokenized-stock>.

481 assets: 0 tradeable, 23 thin, 399 price-only, 59 with no market.

| Symbol | Name | Mint | Token | Pyth | Buy cost $10 / $100 / $1k | Pooled liq. | Class |
|---|---|---|---|---|---|---|---|
| SLVon | iShares Silver Trust (Ondo Tokenized) | `iy11ytbSGcUnrjE6Lfv78TFqxKyUESfku1FugS9ondo` | token-2022, pausable | `Equity.US.SLV/USD` (key) | 0.00% / 1.31% / 13.19% | $45k | thin |
| USOon | United States Oil Fund (Ondo Tokenized) | `rpydAzWdCy85HEmoQkH5PVxYtDYQWjmLxgHHadxondo` | token-2022, pausable | `Equity.US.USO/USD` (key) | 2.05% / 4.75% / 7.56% | $28k | thin |
| NVDAon | NVIDIA (Ondo Tokenized) | `gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo` | token-2022, pausable, UI x1.0017 | `Crypto.NVDAON/USD` (key)<br>`Equity.US.NVDA/USD` (push acct stale; key) | 37.22% / 39.83% / 63.87% | $3k | thin |
| COPXon | Global X Copper Miners ETF (Ondo Tokenized) | `X7j77hTmjZJbepkXXBcsEapM8qNgdfihkFj6CZ5ondo` | token-2022, pausable, UI x1.0024 | `Equity.US.COPX/USD` (key) | 66.31% / 66.31% / 87.96% | $2k | thin |
| AAPLon | Apple (Ondo Tokenized) | `123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo` | token-2022, pausable, UI x1.0039 | `Crypto.AAPLON/USD` (key)<br>`Equity.US.AAPL/USD` (push acct stale; key) | 19.41% / 20.37% / 97.51% | $1k | thin |
| GLDon | SPDR Gold Shares (Ondo Tokenized) | `hWfiw4mcxT8rnNFkk6fsCQSxoxgZ9yVhB6tyeVcondo` | token-2022, pausable | `Equity.US.GLD/USD` (push acct stale; key) | 24.66% / 24.66% / 84.68% | $1k | thin |
| MUon | Micron Technology (Ondo Tokenized) | `Fz9edBpaURPPzpKVRR1A8PENYDEgHqwx5D5th28ondo` | token-2022, pausable, UI x1.0012 | `Equity.US.MU/USD` (push acct stale; key) | 16.16% / 17.45% / 31.39% | $948 | thin |
| BABAon | Alibaba (Ondo Tokenized) | `1zvb9ELBFShBCWKEk5jRTJAaPAwtVt7quEXx1X4ondo` | token-2022, pausable, UI x1.0089 | `Equity.US.BABA/USD` (key) | 36.98% / 45.00% / 64.99% | $859 | thin |
| AMDon | AMD (Ondo Tokenized) | `14diAn5z8kjrKwSC8WLqvBqqe5YmihJhjxRxd8Z6ondo` | token-2022, pausable | `Equity.US.AMD/USD` (key) | 45.41% / 45.41% / 90.27% | $496 | thin |
| QQQon | Invesco QQQ (Ondo Tokenized) | `HrYNm6jTQ71LoFphjVKBTdAE4uja7WsmLG8VxB8ondo` | token-2022, pausable, UI x1.0041 | `Equity.US.QQQ/USD` (push acct stale; key) | 42.68% / 42.69% / 83.79% | $270 | thin |
| AVGOon | Broadcom (Ondo Tokenized) | `1FWZtdWN7y38BSXGzbs8D6Shk88oL9atDNgbVz9ondo` | token-2022, pausable, UI x1.0064 | `Equity.US.AVGO/USD` (push acct stale; key) | 43.77% / 46.90% / 76.92% | $251 | thin |
| IVVon | iShares Core S&P 500 ETF (Ondo Tokenized) | `CqW2pd6dCPG9xKZfAsTovzDsMmAGKJSDBNcwM96ondo` | token-2022, pausable, UI x1.0104 | `Equity.US.IVV/USD` (key) | 46.67% / 46.67% / 86.89% | $195 | thin |
| AMZNon | Amazon (Ondo Tokenized) | `14Tqdo8V1FhzKsE3W2pFsZCzYPQxxupXRcqw9jv6ondo` | token-2022, pausable | `Equity.US.AMZN/USD` (push acct stale; key) | 32.50% / 39.40% / 82.60% | $183 | thin |
| CRCLon | Circle Internet Group (Ondo Tokenized) | `6xHEyem9hmkGtVq6XGCiQUGpPsHBaoYuYdFNZa5ondo` | token-2022, pausable | `Crypto.CRCLON/USD` (key)<br>`Equity.US.CRCL/USD` (push acct stale; key) | 58.16% / 59.02% / 84.98% | $176 | thin |
| MRNAon | Moderna (Ondo Tokenized) | `14VP7DvCAdBCc5XGNZkPt6zhtPzJrWWS64Koxtxyondo` | token-2022, pausable | `Equity.US.MRNA/USD` (key) | 13.52% / 13.52% / 55.76% | $165 | thin |
| ASMLon | ASML Holding NV (Ondo Tokenized) | `1eLZPRsn8bAKmoxsqDMH9Q2m2k7GMNp6RLSQGm8ondo` | token-2022, pausable, UI x1.0066 | `Equity.US.ASML/USD` (key) | 72.97% / 72.97% / 83.74% | $137 | thin |
| PLTRon | Palantir Technologies (Ondo Tokenized) | `HfsnTS5qtdStwec9DfBrunRqnAMYMMz1kjv9Hu9ondo` | token-2022, pausable | `Equity.US.PLTR/USD` (push acct stale; key) | 37.88% / 37.88% / 68.46% | $125 | thin |
| HIMSon | Hims & Hers Health (Ondo Tokenized) | `bdh3njeo19d2TBLAKTGvCWdSoArfVw8uZBAJHY4ondo` | token-2022, pausable | `Equity.US.HIMS/USD` (push acct stale; key) | 41.47% / 66.99% / 73.17% | $122 | thin |
| MSFTon | Microsoft (Ondo Tokenized) | `FRmH6iRkMr33DLG6zVLR7EM4LojBFAuq6NtFzG6ondo` | token-2022, pausable, UI x1.0057 | `Crypto.MSFTON/USD` (key)<br>`Equity.US.MSFT/USD` (push acct stale; key) | 36.11% / 36.11% / 75.95% | $118 | thin |
| DRAMon | Roundhill Memory ETF (Ondo Tokenized) | `oXeD5ZesXfJQ3mxtuZdMaccUsWrE8r1SnpYRP2Bondo` | token-2022, pausable | `Equity.US.DRAM/USD` (key) | 57.83% / 59.08% / 60.95% | $118 | thin |
| NBISon | Nebius Group (Ondo Tokenized) | `DiRshqNDE68bWbGdLHm1GwQ76MvWQG3af6w1NdQondo` | token-2022, pausable | `Equity.US.NBIS/USD` (key) | 74.89% / 74.89% / 88.86% | $118 | thin |
| MCDon | McDonald's (Ondo Tokenized) | `EUbJjmDt8JA222M91bVLZs211siZ2jzbFArH9N3ondo` | token-2022, pausable, UI x1.0219 | `Equity.US.MCD/USD` (push acct stale; key) | 20.47% / 20.47% / 85.95% | $105 | thin |
| SNDKon | SanDisk (Ondo Tokenized) | `EJmUVvDqAdfH5zEohkdS4234bi3c6iunqEMobjmondo` | token-2022, pausable | `Equity.US.SNDK/USD` (push acct stale; key) | 37.74% / 37.74% / 51.54% | $102 | thin |

- **Price-only (399):** PDDon, KOon, FIGon, IRENon, CSCOon, Von, MARAon, SKHYon, BOTon, PURRon, SGOVon, INTCon, SPYon, LLYon, CVXon, TSMon, SPCXon, RGTIon, BACon, TLTon, MRVLon, NATon, CRDOon, JPMon, KEYSon, GMEon, NKEon, CRWDon, GEMIon, KEELon, SYSBon, HIVEon, ALABon, FCXon, VRTon, UBERon, NOWon, ONDSon, SMRon, LITon, AMCon, TSLAon, METAon, RXRXon, TXNon, GOOGLon, JDon, BWETon, AXPon, GLWon, ORCLon, SOXSon, MSTRon, MPon, URNMon, LITEon, ASSTon, CEGon, COINon, FNon, and 339 more (see `assets.json`).
- **No market (59):** IEIon, XYLDon, IJSon, BKCHon, CLOIon, GGOVon, LEMBon, EUHYon, DTCRon, SECUon, ARGTon, BLKGRWon, YLD5on, CEVAon, TENon, BINCon, STNGon, BITAon, EXTRon, BIG5on, DGRWon, IALTon, BRTRon, COROon, INROon, BLCRon, BRHYon, QLTAon, BRLNon, BLKHIon, ATKRon, POWIon, HYGWon, NIKLon, ZDEKon, ZNOVon, ZOCTon, ZSEPon, BLKDIGon, ZAUGon, YLD8on, ZJULon, ZJUNon, VFSon, INCEon, HYSon, ZMAYon, GLTRon, FLQLon, FGDLon, FFOGon, BRAINon, ECHon, SPYSHIELDon, FSOLon, ZAPRon, ZMARon, ZFEBon, HYDBon.


### Tokenized stocks and ETFs: Backpack Securities

Issuer: Backpack Securities. 1:1 backed by shares held at Backpack's US brokerage; who may hold the token on-chain (US vs non-US) is unverified. The token itself is freely transferable on Jupiter. Issuer holds a permanent delegate and a pause authority. Sources: <https://solanacompass.com/news/backpack-securities-launches-tokenized-us-equity-and-etf-trading-on-solana>, <https://news.tokenizer.estate/backpack-tokenizes-micron-shares-solana-on-chain-equity-trading>.

93 assets: 58 tradeable, 34 thin, 1 price-only, 0 with no market.

| Symbol | Name | Mint | Token | Pyth | Buy cost $10 / $100 / $1k | Pooled liq. | Class |
|---|---|---|---|---|---|---|---|
| SPCX | SpaceX - Backpack Securities | `SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb` | token-2022, perm. delegate, pausable | `Equity.US.SPCX/USD` (push acct stale; key) | 0.00% / 0.00% / 0.00% | $3.4M | **tradeable** |
| TTWO | Take-Two Interactive Software - Backpack Securities | `TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo` | token-2022, perm. delegate, pausable | `Equity.US.TTWO/USD` (key) | 0.21% / 0.20% / 0.22% | $2.9M | **tradeable** |
| NVDA | Nvidia - Backpack Securities | `NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv` | token-2022, perm. delegate, pausable | `Equity.US.NVDA/USD` (push acct stale; key) | 0.22% / 0.23% / 0.30% | $738k | **tradeable** |
| TSLA | Tesla - Backpack Securities | `TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S` | token-2022, perm. delegate, pausable | `Equity.US.TSLA/USD` (push acct stale; key) | 0.13% / 0.19% / 0.34% | $580k | **tradeable** |
| DJT | Trump Media & Technology Group Corp. Common Stock - Backpack Securities | `DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF` | token-2022, perm. delegate, pausable | `Equity.US.DJT/USD` (key) | 0.00% / 0.18% / 0.28% | $424k | **tradeable** |
| AMZN | Amazon - Backpack Securities | `AMZNw7cwU9L9c7ewZXxTws2PwQYxBGm2Rxg3FLDBJz9B` | token-2022, perm. delegate, pausable | `Equity.US.AMZN/USD` (push acct stale; key) | 0.15% / 0.16% / 0.13% | $338k | **tradeable** |
| GOOGL | Alphabet - Backpack Securities | `GooGLMvZtJZXHdNZy95RUrAMCCKxV6ghK3qE5ddBgVm5` | token-2022, perm. delegate, pausable | `Equity.US.GOOGL/USD` (push acct stale; key) | 0.29% / 0.30% / 0.40% | $295k | **tradeable** |
| META | Meta Platforms - Backpack Securities | `METAaH6MMZZgy2CTEJq3QdNi7AFVTV3NxHFBfFgLEDd` | token-2022, perm. delegate, pausable | `Crypto.META/USD` (free on-chain)<br>`Equity.US.META/USD` (push acct stale; key) | 0.23% / 0.28% / 0.31% | $291k | **tradeable** |
| QQQ | Invesco QQQ Trust - Backpack Securities | `QQQvDYxG7g11Rr4rnaJqDddmP9ocH74YhE3mDaG37R9` | token-2022, perm. delegate, pausable | `Equity.US.QQQ/USD` (push acct stale; key) | 0.18% / 0.18% / 0.20% | $239k | **tradeable** |
| AMD | Advanced Micro Devices - Backpack Securities | `AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES` | token-2022, perm. delegate, pausable | `Equity.US.AMD/USD` (key) | 0.36% / 0.36% / 0.44% | $233k | **tradeable** |
| AMC | AMC Entertainment - Backpack Securities | `AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc` | token-2022, perm. delegate, pausable | `Crypto.AMC/USD` (key)<br>`Equity.US.AMC/USD` (key) | 0.98% / 1.00% / 1.20% | $232k | **tradeable** |
| MSFT | Microsoft - Backpack Securities | `MSFThX899B1DddH5jkyMpdArWXzP85VXLYDrbGGcRJM` | token-2022, perm. delegate, pausable | `Equity.US.MSFT/USD` (push acct stale; key) | 0.06% / 0.12% / 0.20% | $229k | **tradeable** |
| SQQQ | ProShares UltraPro Short QQQ - Backpack Securities | `SQQQAa3gUxgnqcEsdjPA4RQNQBgB97TnG2hJhk2WaGE` | token-2022, perm. delegate, pausable | `Equity.US.SQQQ/USD` (key) | 0.50% / 0.52% / 0.66% | $228k | **tradeable** |
| DKNG | DraftKings - Backpack Securities | `DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow` | token-2022, perm. delegate, pausable | `Equity.US.DKNG/USD` (key) | 0.21% / 0.37% / 1.03% | $196k | **tradeable** |
| NKE | Nike - Backpack Securities | `NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg` | token-2022, perm. delegate, pausable | `Equity.US.NKE/USD` (key) | 0.29% / 0.40% / 0.74% | $142k | **tradeable** |
| AAPL | Apple - Backpack Securities | `AAPLEDt8RpzPgXyhvFzkMBofvFSQw9gpeMCoUdPdLnB8` | token-2022, perm. delegate, pausable, UI x1.0005 | `Equity.US.AAPL/USD` (push acct stale; key) | 0.12% / 0.18% / 0.33% | $141k | **tradeable** |
| RACE | Ferrari - Backpack Securities | `RACEyWiM2ztEZcJx2AHXU2eWjhxU57x3vXn92b39dLD` | token-2022, perm. delegate, pausable | none | 0.00% / 0.05% / 0.21% | $121k | **tradeable** |
| MU | Micron Technology - Backpack Securities | `MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1` | token-2022, perm. delegate, pausable, UI x1.0001 | `Equity.US.MU/USD` (push acct stale; key) | 0.62% / 0.68% / 0.74% | $118k | **tradeable** |
| HIMS | Hims & Hers Health - Backpack Securities | `HiMSSzzwkZkrXJ4PGVJRdtfLaANeAztjjcgk5Dxe7Lwx` | token-2022, perm. delegate, pausable | `Equity.US.HIMS/USD` (push acct stale; key) | 0.23% / 0.33% / 1.08% | $106k | **tradeable** |
| SKHY | SK Hynix - Backpack Securities | `SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3` | token-2022, perm. delegate, pausable | `Equity.US.SKHY/USD` (key) | 0.36% / 0.36% / 0.36% | $105k | **tradeable** |
| COST | Costco Wholesale - Backpack Securities | `CZEB3WNZuF2Yz1z2H81RcCk8T7fsw82KB33zqamASVsg` | token-2022, perm. delegate, pausable | `Equity.US.COST/USD` (key) | 0.45% / 0.44% / 0.93% | $101k | **tradeable** |
| GRND | Grindr - Backpack Securities | `GRNDYDpqwpCm6jVxpbh4xT5AM4r3p391qYsKTHqgaET2` | token-2022, perm. delegate, pausable | `Equity.US.GRND/USD` (key) | 0.05% / 0.13% / 0.51% | $90k | **tradeable** |
| BOT | RoboStrategy - Backpack Securities | `BoTx8y9ynfdxf5ZjWtCoBVkff52qKA82ysaLU8ZM6d8T` | token-2022, perm. delegate, pausable | `Equity.US.BOT/USD` (key) | 0.50% / 0.52% / 0.55% | $85k | **tradeable** |
| LLY | Eli Lilly and Company - Backpack Securities | `LLYuwZ33keFihgwoxXsBawy31AiRFLFSva32TYq5TvD` | token-2022, perm. delegate, pausable, UI x1.0008 | `Equity.US.LLY/USD` (push acct stale; key) | 0.44% / 0.47% / 0.47% | $81k | **tradeable** |
| RBLX | Roblox - Backpack Securities | `RBLXDGRD64AtRamHMFVcjqne3Ar7NLWtFtYNtsrf1cE` | token-2022, perm. delegate, pausable | `Equity.US.RBLX/USD` (key) | 0.60% / 0.62% / 0.84% | $77k | **tradeable** |
| USO | United States Oil Fund, LP - Backpack Securities | `USNv3NkKA27Dh4nsHJDPhW4VoEcTQmjoZyJt2dqdwFu` | token-2022, perm. delegate, pausable | `Equity.US.USO/USD` (key) | 0.59% / 0.73% / 2.08% | $76k | **tradeable** |
| URA | Global X Uranium ETF - Backpack Securities | `URARfsinxCRw4JpvQhuT4CxavdZXZEMjv9ZwWmWpwag` | token-2022, perm. delegate, pausable | `Equity.US.URA/USD` (key) | 0.48% / 0.55% / 1.40% | $76k | **tradeable** |
| RDDT | Reddit - Backpack Securities | `RDDTGbhHwVXfyCvQMXzzowKjf5qrYBZAnehoXW83ooh` | token-2022, perm. delegate, pausable | `Equity.US.RDDT/USD` (key) | 0.62% / 0.79% / 2.30% | $71k | **tradeable** |
| SNAP | Snap - Backpack Securities | `SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz` | token-2022, perm. delegate, pausable | `Equity.US.SNAP/USD` (key) | 0.54% / 0.56% / 0.86% | $67k | **tradeable** |
| BABA | Alibaba Group Holding - Backpack Securities | `BABANGA4JE7Kkam4nTrALAwAVgsNJUuFJnnkF7S16BZp` | token-2022, perm. delegate, pausable | `Equity.US.BABA/USD` (key) | 0.34% / 0.40% / 0.65% | $67k | **tradeable** |
| LMT | Lockheed Martin - Backpack Securities | `LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV` | token-2022, perm. delegate, pausable | `Equity.US.LMT/USD` (key) | 0.61% / 0.73% / 1.04% | $62k | **tradeable** |
| SNDK | Sandisk - Backpack Securities | `SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH` | token-2022, perm. delegate, pausable | `Equity.US.SNDK/USD` (push acct stale; key) | 0.72% / 0.71% / 0.71% | $61k | **tradeable** |
| PUSA | Powerus Corporation - Backpack Securities | `PUSAG1stksTcAoK9MjinEHUwAYRJsbovywYCk37m6hy` | token-2022, perm. delegate, pausable | none | 0.64% / 0.76% / 1.21% | $60k | **tradeable** |
| OPNW | OpenWorld - Backpack Securities | `oPNWKYTYJyEs2RbpjUXfCTxrNtiTjTcz3ipvUvBBAH2` | token-2022, perm. delegate, pausable | none | 0.13% / 0.13% / 0.13% | $58k | **tradeable** |
| DRAM | Roundhill Memory ETF - Backpack Securities | `DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw` | token-2022, perm. delegate, pausable | `Equity.US.DRAM/USD` (key) | 0.07% / 0.08% / 0.05% | $50k | **tradeable** |
| LULU | lululemon athletica inc. - Backpack Securities | `LULUmT9VMttkfAJE236LXJcYJ2tTP7nunrSWR5G1BdS` | token-2022, perm. delegate, pausable | `Equity.US.LULU/USD` (key) | 0.19% / 0.24% / 0.86% | $49k | **tradeable** |
| UVXY | ProShares Ultra VIX Short-Term Futures ETF - Backpack Securities | `UVXY4ojmAMTaPwUmrRmcuxWHjMHCbz3BxX2RBMzjYKx` | token-2022, perm. delegate, pausable | `Equity.US.UVXY/USD` (key) | 0.04% / 0.08% / 0.47% | $49k | **tradeable** |
| IBM | International Business Machines - Backpack Securities | `BMKdM4yUxX12moFqVk195k7coMbaybd4RUKCUdm7D1Sk` | token-2022, perm. delegate, pausable, UI x1.0048 | `Equity.US.IBM/USD` (key) | 0.49% / 0.52% / 0.78% | $46k | **tradeable** |
| TSM | Taiwan Semiconductor Manufacturing Company - Backpack Securities | `TSM2Hiuf7Z9REcwZFQvsBEekBYCYziWBABfFnj6V6gQ` | token-2022, perm. delegate, pausable | `Equity.US.TSM/USD` (key) | 0.13% / 0.17% / 0.59% | $44k | **tradeable** |
| DELL | Dell Technologies - Backpack Securities | `DELL2aRKQz7DMq5DrKLtkn47ZCnbxXPZXrSGbkmd13wy` | token-2022, perm. delegate, pausable | `Equity.US.DELL/USD` (key) | 0.00% / 0.25% / 1.34% | $43k | **tradeable** |
| SHOP | Shopify - Backpack Securities | `SH55hfaipFAbwT42nQYhRoM5o5t61QpkmJ6p62vXB3m` | token-2022, perm. delegate, pausable | `Equity.US.SHOP/USD` (key) | 0.10% / 0.14% / 0.52% | $40k | **tradeable** |
| BULL | Webull Corporation - Backpack Securities | `BULL151gUXcFV5wXEUqu9Am2L7Qt4bTJRLRuAUjkcspC` | token-2022, perm. delegate, pausable | `Equity.US.BULL/USD` (key) | 0.21% / 0.87% / 2.96% | $39k | **tradeable** |
| ARM | Arm Holdings - Backpack Securities | `ARMbSB1MBRQrY6PNMao1HdQ431VafC6JRJCsGZ2Yv3iJ` | token-2022, perm. delegate, pausable | `Equity.US.ARM/USD` (key) | 0.39% / 0.46% / 1.27% | $39k | **tradeable** |
| SCHH | Schwab U.S. REIT ETF - Backpack Securities | `SCHHJ3jRdSjeFEVAaLrnYdx3Brphn92Ys7z1qkiCtPX` | token-2022, perm. delegate, pausable | none | 0.52% / 0.56% / 1.13% | $38k | **tradeable** |
| UPS | United Parcel Service - Backpack Securities | `UPSqUeMHcWbkdg784XuBUEF9DtySSnW9ur5LAVdcuB9` | token-2022, perm. delegate, pausable | `Equity.US.UPS/USD` (key) | 0.53% / 0.59% / 1.07% | $35k | **tradeable** |
| MSTR | Strategy - Backpack Securities | `MSTRdWXMeZxdE8osAQy3fA4rvTY5rgummDSMEx6U7Nz` | token-2022, perm. delegate, pausable | `Equity.US.MSTR/USD` (push acct stale; key) | 0.82% / 0.89% / 0.89% | $33k | **tradeable** |
| PFE | Pfizer - Backpack Securities | `PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x` | token-2022, perm. delegate, pausable, UI x1.0101 | `Equity.US.PFE/USD` (key) | 0.05% / 0.14% / 0.62% | $33k | **tradeable** |
| BA | The Boeing Company - Backpack Securities | `BArimz1PcKZr8PcPh3tcZ2dg4S7FJLk3cw6R5F8GsHKg` | token-2022, perm. delegate, pausable | `Equity.US.BA/USD` (key) | 0.62% / 0.72% / 2.12% | $33k | **tradeable** |
| DNUT | Krispy Kreme, Inc. Common Stock - Backpack Securities | `DNUTsCvKbKwu2RM72cUuW3TD9YpzArzACcqYQssjPLSk` | token-2022, perm. delegate, pausable | none | 0.44% / 0.55% / 1.59% | $29k | **tradeable** |
| NBIS | Nebius Group N.V. - Backpack Securities | `NBiSF3UaVUFtRzHwAfxyHsBCAZWGEKnMpewAE4oh7BG` | token-2022, perm. delegate, pausable | `Equity.US.NBIS/USD` (key) | 0.63% / 0.99% / 2.26% | $27k | **tradeable** |
| EWZ | iShares MSCI Brazil ETF - Backpack Securities | `EWZzCki1igp2y73UyUM4RCG4QUVMQAtnrQUVNaDHzDxJ` | token-2022, perm. delegate, pausable | `Equity.US.EWZ/USD` (key) | 0.05% / 0.08% / 0.40% | $19k | **tradeable** |
| CMG | Chipotle Mexican Grill - Backpack Securities | `CMGi497VQA9RiHVWpQi5B847vN8RLaEwcMhB5kEUhkAQ` | token-2022, perm. delegate, pausable | `Equity.US.CMG/USD` (key) | 0.00% / 0.30% / 0.64% | $13k | **tradeable** |
| RUM | RUM Group Inc. - Backpack Securities | `RUMsPfFZFnN1ZmGANwP7FNMJMjKH4m9RiMePrtVtLe7` | token-2022, perm. delegate, pausable | `Equity.US.RUM/USD` (key) | 0.21% / 0.25% / 0.65% | $12k | **tradeable** |
| FLWS | 1-800-FLOWERS.COM - Backpack Securities | `FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd` | token-2022, perm. delegate, pausable | none | 0.05% / 0.12% / 0.82% | $12k | **tradeable** |
| SPY | SPDR S&P 500 ETF Trust - Backpack Securities | `SPYBo66VJPFjh1pXMb9Le53kDYWTK1zzYVDeVRWtsbi` | token-2022, perm. delegate, pausable | `Equity.US.SPY/USD` (push acct stale; key) | 0.48% / 0.48% / 0.49% | $11k | **tradeable** |
| AVGO | Broadcom - Backpack Securities | `AVGoo4BQGsEfAmu4HU2deZTaTmLoqB3q3EzKXqAANGYD` | token-2022, perm. delegate, pausable | `Equity.US.AVGO/USD` (push acct stale; key) | 0.00% / 0.51% / 0.84% | $3k | **tradeable** |
| INTC | Intel - Backpack Securities | `iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF` | token-2022, perm. delegate, pausable | `Equity.US.INTC/USD` (key) | 0.84% / 0.84% / 0.85% | $2k | **tradeable** |
| HOOD | Robinhood Markets - Backpack Securities | `HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A` | token-2022, perm. delegate, pausable | `Equity.US.HOOD/USD` (push acct stale; key) | 0.52% / 0.54% / 0.52% | $184 | **tradeable** |
| MRNA | Moderna - Backpack Securities | `MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT` | token-2022, perm. delegate, pausable | `Equity.US.MRNA/USD` (key) | 0.35% / 1.26% / 2.58% | $202k | thin |
| NFLX | Netflix - Backpack Securities | `NFLX7qV57zuVxCoHy3s1jiGZyALraLNwttbxdvmYJLJ` | token-2022, perm. delegate, pausable | `Equity.US.NFLX/USD` (key) | 2.03% / 2.05% / 2.24% | $117k | thin |
| CYPH | Cypherpunk Technologies - Backpack Securities | `CYPHuMmCL1GxJWa2tsPhLKykC7GrHJTCHwbXD4g5uawK` | token-2022, perm. delegate, pausable | `Equity.US.CYPH/USD` (key) | 1.11% / 1.62% / 1.90% | $117k | thin |
| WEN | The Wendy's Company - Backpack Securities | `WENAZ2WyPbmgvUcKfQ8hyMDfBQP9bZ65hsZ5KTFrRGZ` | token-2022, perm. delegate, pausable | `Equity.US.WEN/USD` (key) | 0.58% / 1.13% / 1.37% | $97k | thin |
| BLK | BlackRock - Backpack Securities | `BLKKYfF41c6xRPrtX1rdYbxLE1xxEdZUnxQsB5hcZ8Nf` | token-2022, perm. delegate, pausable | `Equity.US.BLK/USD` (key) | 0.63% / 1.23% / 1.53% | $93k | thin |
| COPX | Global X Copper Miners ETF - Backpack Securities | `CzLTZppPdZtTjyq3WGpHLstoc3GLhu7zH5Zg6xUa6Gv5` | token-2022, perm. delegate, pausable | `Equity.US.COPX/USD` (key) | 1.16% / 1.45% / 1.92% | $74k | thin |
| RKLB | Rocket Lab - Backpack Securities | `RKLBnAXGqv31iZomqsuAWkQm1aqC7JwwvbCfzGdqAhz` | token-2022, perm. delegate, pausable | `Equity.US.RKLB/USD` (push acct stale; key) | 0.54% / 1.17% / 2.72% | $68k | thin |
| MGM | MGM Resorts International - Backpack Securities | `MGMuubtUEirmkhfEQdmGUh4pr7HuUdMWcZXFtpPbVJD` | token-2022, perm. delegate, pausable | `Equity.US.MGM/USD` (key) | 2.03% / 2.06% / 2.37% | $64k | thin |
| EWY | iShares MSCI South Korea ETF - Backpack Securities | `EWY4owSJYMpwN33qGDu5gGxpkQkpMJu8ZUsQJaNZG5dv` | token-2022, perm. delegate, pausable | `Equity.US.EWY/USD` (key) | 1.57% / 1.64% / 2.14% | $62k | thin |
| SPHR | Sphere Entertainment Co. - Backpack Securities | `SPHRp8cZaSQBTp1KMNP4V1X821SXhXWt4Q2yLdyHzju` | token-2022, perm. delegate, pausable | none | 1.10% / 1.13% / 1.47% | $59k | thin |
| LUV | Southwest Airlines Co. - Backpack Securities | `LUV9GB51PNZNRyzzyYK3rtqFfvDvWtRiXZ34wVq2HrX` | token-2022, perm. delegate, pausable | `Equity.US.LUV/USD` (key) | 2.03% / 2.05% / 2.26% | $57k | thin |
| IONQ | IonQ - Backpack Securities | `NQ5hSuXQZrbnrwcDVk2qN73njjd3E3v3badYHnj5thF` | token-2022, perm. delegate, pausable | `Equity.US.IONQ/USD` (key) | 1.21% / 1.36% / 2.81% | $56k | thin |
| PTN | Palatin Technologies, Inc. - Backpack Securities | `PTNzAfFAB4LvoUQEUUGrFMyUoRLExMYjH6CcfyQfsVP` | token-2022, perm. delegate, pausable | none | 1.23% / 1.27% / 1.70% | $55k | thin |
| BE | Bloom Energy - Backpack Securities | `BEBVfXZ8uCxRBuunEbW9wcq9r7W9ySNo14oJBJkDgpZx` | token-2022, perm. delegate, pausable | `Equity.US.BE/USD` (key) | 1.60% / 1.66% / 2.22% | $54k | thin |
| MRVL | Marvell Technology - Backpack Securities | `MRVLSjkR2ceUBukujaD3xCyHP1H3B2SzpsNTZF546jo` | token-2022, perm. delegate, pausable | `Equity.US.MRVL/USD` (key) | 0.82% / 1.62% / 1.89% | $52k | thin |
| CRWV | CoreWeave - Backpack Securities | `CRWVJeR2yEZuDUKYfGuKCHvLz8ywn4LGvovHfy5WiFmi` | token-2022, perm. delegate, pausable | `Equity.US.CRWV/USD` (key) | 0.74% / 1.32% / 2.78% | $50k | thin |
| QUBT | Quantum Computing - Backpack Securities | `QUBTAD8C9bMU9LvmMNgKPhrmBGbHvxpu6vfWQtThxxw` | token-2022, perm. delegate, pausable | `Equity.US.QUBT/USD` (key) | 0.77% / 2.02% / 3.07% | $49k | thin |
| ABNB | Airbnb - Backpack Securities | `ABNB56TteaTZG1S3DY2W8VMncQmHMvNCGaZgAba49CLP` | token-2022, perm. delegate, pausable | `Equity.US.ABNB/USD` (key) | 1.98% / 2.00% / 2.21% | $49k | thin |
| NOK | Nokia Oyj - Backpack Securities | `N7Q5fYX7YRnDQksfdBKnoUb3awm92n7QNAD35X3Rq1X` | token-2022, perm. delegate, pausable | `Equity.US.NOK/USD` (key) | 2.03% / 2.06% / 2.42% | $48k | thin |
| IREN | IREN - Backpack Securities | `RENzhrJQgmAnfcLhU1U5XwAMc6TC15UA6jCbPBaasnj` | token-2022, perm. delegate, pausable | `Equity.US.IREN/USD` (key) | 1.64% / 1.75% / 2.94% | $48k | thin |
| JNJ | Johnson & Johnson - Backpack Securities | `JNJg1znKdF712Phe7L7z52AATAvEjEytBdN2w8Lnh1Y` | token-2022, perm. delegate, pausable | `Equity.US.JNJ/USD` (key) | 0.49% / 1.20% / 1.55% | $44k | thin |
| CHWY | Chewy - Backpack Securities | `CHWYHz2zfKajomqPV9it26n7vu7AgZZfqGHXCWtGWuJg` | token-2022, perm. delegate, pausable | none | 0.33% / 1.03% / 1.31% | $43k | thin |
| RIOT | Riot Platforms - Backpack Securities | `RUKx7nBgm94pwRPbVm99xYVdcTDTUyGs8Cw3VSYQXHf` | token-2022, perm. delegate, pausable | `Equity.US.RIOT/USD` (key) | 1.97% / 2.03% / 2.69% | $41k | thin |
| BB | BlackBerry - Backpack Securities | `BBosJLw8ZzoATiEyywiifx7AgmrD2Cm3XjFWbhbRhChy` | token-2022, perm. delegate, pausable | `Equity.US.BB/USD` (key) | 1.46% / 1.93% / 2.15% | $39k | thin |
| WULF | TeraWulf - Backpack Securities | `WULFeyfrj1VJKD9HhRTcW8R4g5HefUA11HDEdBv2WxD` | token-2022, perm. delegate, pausable | `Equity.US.WULF/USD` (key) | 1.86% / 1.89% / 2.21% | $35k | thin |
| BROS | Dutch Bros - Backpack Securities | `BRVaZKg6J9iF2BEsdpsxJ9NyvN9PPxPZuoQUX2v8qqkk` | token-2022, perm. delegate, pausable | none | 1.68% / 1.73% / 2.19% | $29k | thin |
| MNST | Monster Beverage - Backpack Securities | `MNSTy46haEN7sEaeXAWBXG6zHaRikCvqf3krAEDzxr2` | token-2022, perm. delegate, pausable | `Equity.US.MNST/USD` (key) | 0.98% / 1.07% / 1.25% | $24k | thin |
| HTZ | Hertz Global Holdings, Inc Common Stock - Backpack Securities | `HTZsLG4zqaNvWMwXSLHH3GG5KyJpKwpBRsKVdMG6hvzP` | token-2022, perm. delegate, pausable | none | 1.14% / 1.18% / 1.58% | $24k | thin |
| FWDI | Forward Industries, Inc. - Backpack Securities | `FWDtiB5fXHdVAewPqvHPL2dh4aBC1C6GacQbePoQXKjz` | token-2022, perm. delegate, pausable | `Equity.US.FWDI/USD` (push acct stale; key) | 1.31% / 1.70% / 2.63% | $22k | thin |
| FLY | Firefly Aerospace - Backpack Securities | `FLYRq3en8r2Z69gN3KyAnDrvnitEJNkwPYY7favinHeD` | token-2022, perm. delegate, pausable | `Equity.US.FLY/USD` (key) | 0.27% / 3.39% / 20.20% | $9k | thin |
| RIVN | Rivian Automotive - Backpack Securities | `RcZmt84VMJv9bDhKqmw1uWDahYrUT468VwAChTnfD8p` | token-2022, perm. delegate, pausable | `Equity.US.RIVN/USD` (key) | 1.05% / 1.41% / 2.96% | $8k | thin |
| GPRO | GoPro - Backpack Securities | `GPRR2u6NS5yBQHWGauoJ9HXgjrTH8dDsrBfTV5zAYvDH` | token-2022, perm. delegate, pausable | `Equity.US.GPRO/USD` (key) | 1.60% / 1.67% / 2.34% | $8k | thin |
| CBRS | Cerebras Systems - Backpack Securities | `CBRSFBbQPpp77NpMcwbTN6fhBHmZM94oFLJvruytw4Fi` | token-2022, perm. delegate, pausable | `Equity.US.CBRS/USD` (key) | 1.77% / 1.80% / 2.16% | $4k | thin |
| TKO | TKO Group Holdings - Backpack Securities | `TKVC45Wshi9sjunhyTAyg7xHRVCSHoSe4AebGiFDkDC` | token-2022, perm. delegate, pausable | `Equity.US.TKO/USD` (key) | 1.63% / 1.66% / 2.00% | $486 | thin |

- **Price-only (1):** XYZ.


### Tokenized stocks: Remora rStocks

Issuer: Remora Markets (rStocks). Not on Jupiter's verified list. Issuer terms unverified. Sources: <https://lite-api.jup.ag/tokens/v2/search?query=rStock>.

10 assets: 0 tradeable, 0 thin, 10 price-only, 0 with no market.

_None._

- **Price-only (10):** TSLAr, SPYr, PPLTr, CPERr, NVDAr, SLVr, GLDr, CRCLr, MSTRr, PALLr.


### Pre-IPO tokens (PreStocks, Tessera)

Issuer: PreStocks (SPV exposure to private companies). Indirect SPV exposure, not shares. Anthropic and OpenAI have said SPV transfers of their stock are void, and the tokens fell 34-39%. Token-2022 transfer fee on every transfer (see transferFeeBps) and a permanent delegate. Sources: <https://coinmarketcap.com/academy/article/anthropic-openai-tokenized-share-warning>, <https://blocmates.com/articles/prestocks-modernizing-and-democratizing-access-to-pre-ipo-stocks>.

Tessera: Indirect pre-IPO exposure; issuer terms unverified. Token-2022 transfer fee applies (see transferFeeBps).

13 assets: 3 tradeable, 9 thin, 1 price-only, 0 with no market.

| Symbol | Name | Issuer | Mint | Token | Pyth | Buy cost $10 / $100 / $1k | Pooled liq. | Class |
|---|---|---|---|---|---|---|---|---|
| tOpenAI | T-OpenAI | Tessera (pre-IPO exposure) | `oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ` | token-2022, fee 0.2% | `Equity.Index.OPENAI/USD` (key) | 0.44% / 0.44% / 0.44% | $708k | **tradeable** |
| tKalshi | T-Kalshi | Tessera (pre-IPO exposure) | `TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ` | token-2022, fee 0.2% | none | 0.43% / 0.43% / 0.56% | $94k | **tradeable** |
| tSpaceX | T-SpaceX | Tessera (pre-IPO exposure) | `TSPXcLV76s6V2zDiZQ18kBfcbnjaE2ZzNT3ga2Pd99v` | token-2022 | none | 0.80% / 0.80% / 0.80% | $13k | **tradeable** |
| ANTHROPIC | Anthropic PreStocks | PreStocks (SPV exposure to private companies) | `Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw` | token-2022, fee 1%, perm. delegate, pausable, UI x10 | none | 1.89% / 1.95% / 2.01% | $1.2M | thin |
| OPENAI | OpenAI PreStocks | PreStocks (SPV exposure to private companies) | `PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF` | token-2022, fee 1%, perm. delegate, pausable, UI x1.4861 | `Equity.Index.OPENAI/USD` (key) | 2.20% / 2.71% / 3.63% | $717k | thin |
| ANDURIL | Anduril PreStocks | PreStocks (SPV exposure to private companies) | `PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB` | token-2022, fee 1%, perm. delegate, pausable | none | 2.03% / 2.03% / 2.03% | $493k | thin |
| NEURALINK | Neuralink PreStocks | PreStocks (SPV exposure to private companies) | `PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S` | token-2022, fee 1%, perm. delegate, pausable | none | 3.47% / 3.53% / 3.61% | $375k | thin |
| POLYMARKET | Polymarket PreStocks | PreStocks (SPV exposure to private companies) | `Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP` | token-2022, fee 1%, perm. delegate, pausable | none | 3.48% / 3.49% / 3.63% | $273k | thin |
| KALSHI | Kalshi PreStocks | PreStocks (SPV exposure to private companies) | `PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua` | token-2022, fee 1%, perm. delegate, pausable | none | 3.50% / 3.52% / 3.79% | $83k | thin |
| FIGUREAI | Figure AI PreStocks | PreStocks (SPV exposure to private companies) | `PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd` | token-2022, fee 1%, perm. delegate, pausable | none | 3.52% / 3.54% / 3.73% | $49k | thin |
| SPACEX | SpaceX PreStocks | PreStocks (SPV exposure to private companies) | `PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh` | token-2022, fee 1%, perm. delegate, pausable, UI x5 | none | 2.85% / 2.97% / 4.21% | $37k | thin |
| OURA | Oura PreStocks | PreStocks (SPV exposure to private companies) | `Pre9atBqkocK1QngFy7Q7zvyQictEFpXdLi6bZ2qnYy` | token-2022, fee 1%, perm. delegate, pausable, UI x2 | none | 3.52% / 3.56% / 3.95% | $32k | thin |

- **Price-only (1):** XAI.


### Leveraged equity tokens (SHIFT)

Issuer: SHIFT RWA (leveraged equity tokens). Daily-rebalanced 1-3x long/short equity tokens; NAV tracking and liquidity are unproven. Eligibility unverified. Sources: <https://solanacompass.com/news/shift-rwa-lists-leveraged-tokenized-equities-on-jupiter-adding-no-liquidation-stock-exposure-to-solana-defi>.

8 assets: 0 tradeable, 0 thin, 8 price-only, 0 with no market.

_None._

- **Price-only (8):** SPX3S, TSL1S, SOX3L, SPCX2L, TSL2L, SPCX2S, SOX3S, SPX3L.


### Physical commodities

Tokens backed by metal in a vault. Gold and silver ETF tokens (GLDx, SLVon, and so on) are listed with the stocks above and tagged with the Commodities theme. Issuer mappings marked unverified were matched by name and Jupiter tag only.

6 assets: 5 tradeable, 0 thin, 1 price-only, 0 with no market.

| Symbol | Name | Issuer | Mint | Token | Pyth | Buy cost $10 / $100 / $1k | Pooled liq. | Class |
|---|---|---|---|---|---|---|---|---|
| XAUt0 | Tether Gold | Tether (XAUt0, omnichain XAUT) | `AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P` | spl-token | `Crypto.XAUT/USD` (push acct stale; key)<br>`Metal.XAU/USD` (free on-chain) | 0.12% / 0.12% / 0.17% | $144k | **tradeable** |
| GOLD | GOLD | unverified (token named GOLD, Jupiter tag commodities) | `GoLDppdjB1vDTPSGxyMJFqdnj134yH6Prg9eqsGDiw6A` | spl-token | `Metal.XAU/USD` (free on-chain) | 0.46% / 0.46% / 0.57% | $82k | **tradeable** |
| VNXAU | VNX Gold | VNX (VNX Gold) | `9TPL8droGJ7jThsq4momaoz6uhTcvX2SeMqipoPmNa8R` | spl-token | `Metal.XAU/USD` (free on-chain) | 0.34% / 0.35% / 0.47% | $54k | **tradeable** |
| XAUM | Matrixdock Gold | Matrixdock (XAUm) | `5aLhp9VnUEKcsdtkfsf2DUgpJfomx7GmYVny24dHUZoB` | token-2022, perm. delegate, pausable | `Metal.XAU/USD` (free on-chain) | 0.42% / 0.51% / 0.97% | $44k | **tradeable** |
| PAXG | PAX Gold | Paxos (PAX Gold) | `5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW` | token-2022, perm. delegate | `Crypto.PAXG/USD` (free on-chain)<br>`Metal.XAU/USD` (free on-chain) | 0.13% / 0.10% / 0.12% | $2k | **tradeable** |

- **Price-only (1):** DGLD.


### Tokenized treasuries and yield tokens

Permissionless on the secondary market. Primary mint and redeem usually need the issuer's KYC. Jupiter Lend receipts (jlUSDC and others) are covered under USDC yield.

11 assets: 10 tradeable, 0 thin, 1 price-only, 0 with no market.

| Symbol | Name | Issuer | Mint | Token | Pyth | Buy cost $10 / $100 / $1k | Pooled liq. | Class |
|---|---|---|---|---|---|---|---|---|
| syrupUSDC | Syrup USDC | Maple (syrupUSDC) | `AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj` | spl-token | `Crypto.SYRUPUSDC/USD` (free on-chain) | 0.05% / 0.05% / 0.05% | $7.9M | **tradeable** |
| PRIME |  | unverified (PRIME, Jupiter tag yb) | `3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7` | spl-token | `Crypto.PRIME/USD` (push acct stale; key) | 0.04% / 0.04% / 0.04% | $7.7M | **tradeable** |
| PST | PayFi Strategy Token USDC | Huma (PayFi Strategy Token) | `59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw` | spl-token | none | 0.03% / 0.03% / 0.03% | $3.8M | **tradeable** |
| USDY | Ondo US Dollar Yield | Ondo Finance (USDY, tokenized notes on T-bills) | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` | spl-token | `Crypto.USDY/USD` (free on-chain) | 0.35% / 0.35% / 0.35% | $1.9M | **tradeable** |
| ONyc | OnRe Tokenized Reinsurance | OnRe (tokenized reinsurance) | `5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5` | spl-token | none | 0.04% / 0.04% / 0.05% | $1.5M | **tradeable** |
| eUSX | eUSX | unverified (eUSX) | `3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC` | spl-token | none | 0.00% / 0.00% / 0.00% | $942k | **tradeable** |
| USD* | USD Star | unverified (USD Star) | `star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM` | spl-token | none | 0.04% / 0.04% / 0.04% | $5k | **tradeable** |
| eHYUSD | Earn Hylo USD | unverified (Earn Hylo USD) | `HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz` | spl-token | none | 0.03% / 0.03% / 0.03% | $2k | **tradeable** |
| wYLDS |  | unverified (wYLDS) | `8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih` | spl-token | none | 0.09% / 0.25% / no route | $987 | **tradeable** |
| sUSDe | Staked USDe | unverified (Staked USDe) | `Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN` | spl-token | `Crypto.SUSDE/USD` (free on-chain) | 0.11% / 0.17% / 1.14% | $961 | **tradeable** |

- **Price-only (1):** sUSD.


#### Excluded: permissioned treasuries and funds

These need KYC or an allowlisted wallet, so a user's wallet can't simply buy them. Not measured.

| Symbol | Name | Issuer | Why excluded | Source |
|---|---|---|---|---|
| OUSG | Ondo Short-Term US Government Treasuries | Ondo Finance | KYC plus qualified-purchaser checks; allowlisted wallets only | <https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers> |
| BUIDL | BlackRock USD Institutional Digital Liquidity Fund | BlackRock / Securitize | Qualified purchasers only ($5M minimum); transfer-agent allowlist | <https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers> |
| BENJI | Franklin OnChain US Government Money Fund | Franklin Templeton | Fund-share registry with KYC; only registered wallets | <https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers> |
| USTB / USCC | Superstate Short Duration Treasury / Crypto Carry | Superstate | Allowlisted wallets after KYC (accredited or qualified) | <https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers> |
| ACRED | Apollo Diversified Credit Securitize Fund | Apollo / Securitize | Accredited investors only; transfer-agent allowlist | <https://eco.com/support/en/articles/15254021-tokenized-treasury-kyc-requirements-2026-buidl-ousg-benji-access-tiers> |
| VBILL | VanEck Treasury Fund | VanEck / Securitize | Qualified investors only; transfer-agent allowlist | <https://platform.solana.com/docs/tutorials/tokenize-a-treasury-fund> |

Solana mint addresses for these are **unverified**: none is on Jupiter's verified list, and token search returns only look-alike tokens.

### Other real-world assets

Tokens Jupiter tags `rwa` or `stocks` that fit none of the groups above. Issuers are unverified unless stated.

1 assets: 0 tradeable, 0 thin, 0 price-only, 0 with no market, 1 excluded.

_None._

- **Excluded (1):** GLXY.


## Phoenix perps

_Measured 2026-11-17T18:33:19.307Z._ Not available in the US or sanctioned jurisdictions (Phoenix docs). Exchange status is 'gated': traders must register via a referral code or builder onboarding before trading. Collateral is Phoenix USD (PhUsd), converted from USDC through the Ember program. Program `EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih`; collateral mint `PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A`. A short is an Ask-side market order. Exchange status flags: initialized, active, gated.

Sources: <https://perp-api.phoenix.trade/exchange>, <https://perp-api.phoenix.trade/v1/exchange/snapshot>, <https://perp-api.phoenix.trade/v1/view/orderbook/{symbol}>, <https://docs.phoenix.trade>, <https://github.com/Ellipsis-Labs/rise-public>.

Max leverage is the first leverage tier. Open interest is base units times mid. Depth is resting size within 1% of mid on each side. Buy impact walks the live asks from mid.

### Equities (47)

| Symbol | Market | Max lev. | Open interest | Depth ±1% (bid / ask) | Spread | Buy impact $100 / $1k | Pyth | Class |
|---|---|---|---|---|---|---|---|---|
| NVDA | `AzySnZQCNjkQMtm5ZDd2FjKYTjBoNb5Bv5Dsm3WyRkbj` | 20x | $1.0M | $540k / $542k | 3.9 bps | 0.02% / 0.02% | `Equity.US.NVDA/USD` (key) | **tradeable** |
| ANTHROPIC | `8s3kq4sFAZuwXaUsWExgD2i3edQ61PeRpTya5EvHSuhR` | 6x (isolated) | $852k | $31k / $32k | 5.9 bps | 0.03% / 0.08% | none | **tradeable** |
| GOOGL | `BssatSRXDNf5J7465caVwLj9tj3tUnCWuBKMUbY2xsxC` | 20x | $332k | $580k / $582k | 4.3 bps | 0.02% / 0.02% | `Equity.US.GOOGL/USD` (key) | **tradeable** |
| SPCX | `HCPybc8PFzS3gL2AHWXtT7jT1WDYSva7A6qf9aVGiLMf` | 15x | $325k | $414k / $428k | 0.7 bps | 0.00% / 0.00% | none | **tradeable** |
| META | `8pnw1s5jjAyUsJ99hxvHRhb8djoE42ftJ2H1dwAYwRfA` | 20x | $304k | $517k / $523k | 5.2 bps | 0.03% / 0.03% | `Equity.US.META/USD` (key) | **tradeable** |
| TSM | `D4pD7YcXo1Nd6DkAYiDQ6Sky9j6S1yJQJ2exd7R9imXZ` | 10x | $186k | $441k / $446k | 5.0 bps | 0.03% / 0.03% | `Equity.US.TSM/USD` (key) | **tradeable** |
| QQQ | `95i7EhCz9oW816FkDYjqoFwE1zbZqXuXPqzfWAESAzSm` | 20x | $161k | $807k / $738k | 1.5 bps | 0.03% / 0.03% | `Equity.US.QQQ/USD` (key) | **tradeable** |
| TSLA | `9ZKCwuQDRYkxoMhwk8aiKfYmUYfymdtnYhprf995JmD2` | 20x | $160k | $466k / $471k | 4.2 bps | 0.02% / 0.02% | `Equity.US.TSLA/USD` (key) | **tradeable** |
| AMZN | `6YMH94edtLcktxTosAxsgjPc8ZgrKnG6x6ozRHAykhRs` | 20x | $151k | $569k / $572k | 3.9 bps | 0.02% / 0.02% | `Equity.US.AMZN/USD` (key) | **tradeable** |
| SNDK | `HGFx44Fmfxp6Ggk9n69WLnY6oGABGYiq9crpRHdSsSfJ` | 15x | $131k | $397k / $402k | 12.7 bps | 0.06% / 0.06% | `Equity.US.SNDK/USD` (key) | **tradeable** |
| MU | `7STbLCQCPifN3RWFpcaufrTdiTV8s2NY3LiGkqBF9Pdg` | 15x | $117k | $399k / $404k | 5.8 bps | 0.03% / 0.03% | `Equity.US.MU/USD` (key) | **tradeable** |
| AMD | `ABBz13DENxvLRLh6pjHxNsxBPNNbEnfiMPPXrx8sK7qN` | 10x | $115k | $472k / $477k | 7.0 bps | 0.03% / 0.04% | `Equity.US.AMD/USD` (key) | **tradeable** |
| TLT | `CB4rQEPWJ4dYyAc8qWMS9qWGiuUJuZ6trfyHyicP73Ru` | 20x | $110k | $282k / $283k | 2.5 bps | 0.01% / 0.01% | `Equity.US.TLT/USD` (key) | **tradeable** |
| SPY | `FbkK74mnwf51gyccTJxDLWQNw9yN3Ff8jsUXUCEw4LPZ` | 20x | $97k | $829k / $726k | 0.8 bps | 0.01% / 0.01% | `Equity.US.SPY/USD` (key) | **tradeable** |
| ORCL | `9JJrvzpzTp5BrnuiGdUNkYZ8veRPgruR61RLmPhcPC8i` | 10x | $83k | $409k / $413k | 5.3 bps | 0.03% / 0.03% | `Equity.US.ORCL/USD` (key) | **tradeable** |
| MSFT | `7tZA5NniJBMKay13po6udExeLSFkFLnuXT6fXcunGaT8` | 20x | $83k | $644k / $647k | 4.0 bps | 0.02% / 0.02% | `Equity.US.MSFT/USD` (key) | **tradeable** |
| SKHY | `8QXmkGdGyz6PFUzoQAa56oZEjFFMrDhhkT8E1HhzV9Rh` | 10x | $82k | $406k / $410k | 6.6 bps | 0.03% / 0.03% | `Equity.US.SKHY/USD` (key) | **tradeable** |
| AAPL | `5pheia5Tou27SJnJjQdrRUMpbWmXF5jU7cXMLBt8upzz` | 20x | $76k | $594k / $597k | 4.0 bps | 0.02% / 0.02% | `Equity.US.AAPL/USD` (key) | **tradeable** |
| ARM | `9jdfERWjLnxo9dZpsyRD3hqfFG5oTZrxPugiHJNGXsZx` | 10x | $72k | $394k / $400k | 14.4 bps | 0.07% / 0.07% | `Equity.US.ARM/USD` (key) | **tradeable** |
| HOOD | `9qQELE9sXDhyVHSzgJfgXHbWfMF77AMgZoAYTxgZZkTr` | 10x | $72k | $399k / $403k | 5.9 bps | 0.03% / 0.03% | `Equity.US.HOOD/USD` (key) | **tradeable** |
| NFLX | `HFjXg3xNthvP2fTfMXefCu8KMbckKyWmB1PAPwdjU391` | 10x | $67k | $504k / $509k | 4.0 bps | 0.02% / 0.02% | `Equity.US.NFLX/USD` (key) | **tradeable** |
| PLTR | `DqX6VGx2mo7EZsbEhgFeoXNJBReyJphA9QMj8pN9sh55` | 10x | $64k | $423k / $428k | 3.8 bps | 0.02% / 0.02% | `Equity.US.PLTR/USD` (key) | **tradeable** |
| DELL | `gQsEpX7cFLzQ19X3gFVh2wAcukZ1mL2icVqeryub5tc` | 10x | $62k | $403k / $407k | 8.3 bps | 0.04% / 0.04% | `Equity.US.DELL/USD` (key) | **tradeable** |
| BABA | `2DEhy1RRi9LmPbsQKrX5mvbL7iwBB3xECzwvhy1fGYH2` | 10x | $60k | $406k / $411k | 4.6 bps | 0.02% / 0.02% | `Equity.US.BABA/USD` (key) | **tradeable** |
| QCOM | `64EcgJyq6vgtkpDQU5YLDiJYNbLDBtqjyomvqrbtac1d` | 10x | $60k | $398k / $403k | 12.0 bps | 0.06% / 0.06% | `Equity.US.QCOM/USD` (key) | **tradeable** |
| INTC | `B9upYgp7z7dFxLFMVxxLiCbp2gujrZGCvpCKdAc4xT3Q` | 10x | $57k | $396k / $401k | 7.4 bps | 0.04% / 0.04% | `Equity.US.INTC/USD` (key) | **tradeable** |
| MRNA | `ErZ7g7oZvnRoS2CCx2mJ53gcAFYubnN8WAcB78aSzM5w` | 10x | $56k | $178k / $177k | 10.7 bps | 0.05% / 0.08% | `Equity.US.MRNA/USD` (key) | **tradeable** |
| COIN | `5FCgNAooQZtw5So8UtYqjfC75MeA8Dnpn56iUz61W3xN` | 10x | $52k | $404k / $408k | 12.0 bps | 0.06% / 0.06% | `Equity.US.COIN/USD` (key) | **tradeable** |
| CRCL | `8qaFds6uMGjCDwWRZE5qD1JzCEzBdR2RSd1tiB8HHTyX` | 10x | $50k | $379k / $386k | 14.6 bps | 0.07% / 0.08% | `Equity.US.CRCL/USD` (key) | **tradeable** |
| ASML | `HN2HKXdadc3CSsdu1bNaXXNrawVZ6EYNpg5pntv2567a` | 10x | $49k | $412k / $416k | 8.8 bps | 0.04% / 0.04% | `Equity.US.ASML/USD` (key) | **tradeable** |
| CRWV | `2NWXGa6fqhLLMyJsoNhuMHXZuqUdb6DAJRYaQR8CvbB3` | 10x | $49k | $396k / $402k | 8.1 bps | 0.04% / 0.04% | `Equity.US.CRWV/USD` (key) | **tradeable** |
| CRWD | `4XgPoTWesw4E37zis1ypJuDUPk9m97sPBW8eJ4XV7qd1` | 10x | $48k | $178k / $177k | 6.4 bps | 0.03% / 0.06% | `Equity.US.CRWD/USD` (key) | **tradeable** |
| MSTR | `G86UMmDMW8aAEr6Twi2V2WzVRYQmd6DZBvSeSywnhVDJ` | 10x | $43k | $597k / $604k | 4.3 bps | 0.02% / 0.02% | `Equity.US.MSTR/USD` (key) | **tradeable** |
| LLY | `92yyZnBGGDb9wohtT2ZZLx6Y8TCKgMZSp8stCvyjZws4` | 10x | $42k | $178k / $177k | 7.1 bps | 0.04% / 0.06% | `Equity.US.LLY/USD` (key) | **tradeable** |
| TXN | `6vGf6GW9VBMrnKjYiJHKUMx1EAYbc81StDTSwYTB7r6w` | 5x | $39k | $68k / $57k | 8.9 bps | 0.04% / 0.04% | `Equity.US.TXN/USD` (key) | **tradeable** |
| IBM | `9wqYf8WTagujWni2C9aVFf9TAEz3pSsQvQvWE6cwCbGv` | 10x | $37k | $433k / $438k | 6.9 bps | 0.03% / 0.03% | `Equity.US.IBM/USD` (key) | **tradeable** |
| PANW | `6ButqYCkGwh9xafXaPrYcGP2dURNcZzay8uVEe9CTmTy` | 10x | $34k | $49k / $47k | 6.5 bps | 0.08% / 0.09% | `Equity.US.PANW/USD` (key) | **tradeable** |
| KLAC | `BUXkUXAWfWxXc8BssaScmMjm4vPzaTVRXvZQZbrRCqmN` | 5x | $31k | $49k / $47k | 5.6 bps | 0.08% / 0.09% | `Equity.US.KLAC/USD` (key) | **tradeable** |
| NET | `ACfj7jHeshFZkityUdr6qTYzyc4PMd1G44EhMgYC1uKA` | 10x | $21k | $78k / $79k | 6.4 bps | 0.03% / 0.07% | `Equity.US.NET/USD` (key) | **tradeable** |
| CSCO | `EvDzhxywsHzPWGxrr8XuhjgABK2FFJCCjgVCdbWQEa2n` | 5x | $19k | $402k / $406k | 4.2 bps | 0.02% / 0.02% | `Equity.US.CSCO/USD` (key) | **tradeable** |
| OPEN | `GroqGjZRM6MS3BMxWjBgDunbLeDxh17gMTaDb5HwuB4u` | 5x | $18k | $65k / $66k | 83.6 bps | 0.42% / 0.42% | `Equity.US.OPEN/USD` (key) | **tradeable** |
| AMAT | `AvPTRe4XjC1xdVhwzUiVwDDfqrqm6eVaKMAnS39raEjW` | 10x | $18k | $444k / $449k | 9.9 bps | 0.05% / 0.05% | `Equity.US.AMAT/USD` (key) | **tradeable** |
| MRVL | `754w7t2WUzYy7urG7TMKPjJ9QXHQQaN2XtGfYyLBYZjG` | 10x | $17k | $177k / $178k | 9.7 bps | 0.05% / 0.09% | `Equity.US.MRVL/USD` (key) | **tradeable** |
| CBRS | `E9ZzHqXra4t3tQAZRNQq5215rpFoXu9pRQD1noqSZC4v` | 10x | $16k | $84k / $83k | 21.6 bps | 0.11% / 0.18% | `Equity.US.CBRS/USD` (key) | **tradeable** |
| AVGO | `2YrxmiNkyd7ikCorvw2acVyQqRocX9yrvwveX4hxCQZ5` | 10x | $14k | $178k / $177k | 7.7 bps | 0.04% / 0.07% | `Equity.US.AVGO/USD` (key) | **tradeable** |
| IREN | `AGBw8hyKQ19Djd1vLueaep5e8M612Q2cBoiA17bER7z3` | 10x | $11k | $83k / $84k | 14.0 bps | 0.07% / 0.11% | `Equity.US.IREN/USD` (key) | **tradeable** |
| NBIS | `13gh32h3RQszCZze6RzTnd3DZWRLCTYKNNLjS8HxnKeT` | 10x | $10k | $398k / $404k | 22.6 bps | 0.11% / 0.11% | `Equity.US.NBIS/USD` (key) | **tradeable** |

### Commodities (4)

| Symbol | Market | Max lev. | Open interest | Depth ±1% (bid / ask) | Spread | Buy impact $100 / $1k | Pyth | Class |
|---|---|---|---|---|---|---|---|---|
| SILVER | `GD4XZsTfAbjromE1zac61AUAhyfXhwFa8soBmUo59WqB` | 25x (isolated) | $57k | $338k / $340k | 5.1 bps | 0.03% / 0.03% | `Metal.XAG/USD` (key) | **tradeable** |
| GOLD | `7B7hDscDNBGFpNGypFygoiANCpdM3JR2PY3JbvPvQtmk` | 25x (isolated) | $56k | $581k / $584k | 4.1 bps | 0.02% / 0.04% | `Metal.XAU/USD` (free on-chain) | **tradeable** |
| WTIOIL | `aYRsjCr1JEcdPWYeztgRWz8zDTs2mzhQ1hTxNWCmXND` | 20x (isolated) | $9k | $517k / $519k | 4.7 bps | 0.02% / 0.03% | `Commodities.Index.WTI1M/USD` (key) | **tradeable** |
| COPPER | `CYBXMLK8N5SRiWcFRw3vHrLez8bW9uTxSGxr9ZL6MjkJ` | 20x (isolated) | $5k | $147k / $148k | 4.9 bps | 0.02% / 0.04% | `Commodities.Index.CU/USD` (key) | **tradeable** |

### Crypto (55)

| Symbol | Market | Max lev. | Open interest | Depth ±1% (bid / ask) | Spread | Buy impact $100 / $1k | Pyth | Class |
|---|---|---|---|---|---|---|---|---|
| SOL | `71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2` | 25x | $1.7M | $2.0M / $2.0M | 1.4 bps | 0.01% / 0.01% | `Crypto.SOL/USD` (free on-chain) | **tradeable** |
| ZEC | `FTbbqCP2N2NkUHw1nMPpBhiQCrYGiMQAhK7g1G8NJKEt` | 10x | $1.6M | $409k / $385k | 4.1 bps | 0.02% / 0.02% | `Crypto.ZEC/USD` (free on-chain) | **tradeable** |
| BTC | `AXFz1MuzMUBHi5UKJuK3FDCQ73o3rSzubGU2mPr4LLU7` | 40x | $1.2M | $2.6M / $2.9M | 0.2 bps | 0.00% / 0.00% | `Crypto.BTC/USD` (free on-chain) | **tradeable** |
| NEAR | `AHLLA4oggZssMt1M3sfyZ1z2XWt9m6JjNzjS5getE78q` | 10x | $499k | $253k / $195k | 4.4 bps | 0.02% / 0.04% | `Crypto.NEAR/USD` (free on-chain) | **tradeable** |
| ETH | `9u7aqptdRFbsnnoHtjK13E5JkeM14EW5fAKTRPidVF88` | 25x | $411k | $1.4M / $1.6M | 0.6 bps | 0.00% / 0.00% | `Crypto.ETH/USD` (free on-chain) | **tradeable** |
| BNB | `4Xd7E3eBXazSoudAMACsNdezA4UuJETURL1S6fqpjcTR` | 10x | $269k | $163k / $165k | 2.4 bps | 0.01% / 0.03% | `Crypto.BNB/USD` (free on-chain) | **tradeable** |
| HYPE | `CEx9Mgz5cAmWwy6D5H2xGrhmwKeC5L7KtYhFhVGtiBaZ` | 10x | $245k | $480k / $482k | 3.1 bps | 0.02% / 0.02% | `Crypto.HYPE/USD` (free on-chain) | **tradeable** |
| MON | `7hnu7Fm4UXF3K5wpytJuaSeAjw2XYDN4avgy6ZDKCPhs` | 5x | $245k | $130k / $132k | 6.8 bps | 0.03% / 0.05% | `Crypto.MON/USD` (free on-chain) | **tradeable** |
| kPEPE | `Fw9WM8cFMMNxynsvCE5wrVgYNqh6jkmCZCCdHeqM69uU` | 10x | $152k | $61k / $62k | 10.8 bps | 0.05% / 0.10% | none | **tradeable** |
| MORPHO | `7HPBU4Z1ZBxy6xSfHhgHfTFNXfGh8E4NVHZKJZcBytie` | 5x | $141k | $127k / $36k | 6.9 bps | 0.03% / 0.05% | `Crypto.MORPHO/USD` (key) | **tradeable** |
| BP | `As2q5jm9Y58s2Fs9ytpSgpBeWp4Bd1kX252Zjp3yDuo5` | 5x (isolated) | $128k | $3k / $1k | 44.3 bps | 0.26% / 0.53% | `Crypto.BP/USD` (free on-chain) | **tradeable** |
| JUP | `9vhQ2yo3b23vQ75iK7qQTRcVkqtpLjaWuphkZ2TQiYEE` | 10x | $72k | $129k / $131k | 8.8 bps | 0.04% / 0.07% | `Crypto.JUP/USD` (free on-chain) | **tradeable** |
| XPL | `9HTT4Do4i9NM6Lc8vBE1qPEhEDejuNkza3dnUstyzfcp` | 10x | $69k | $123k / $125k | 4.4 bps | 0.02% / 0.05% | `Crypto.XPL/USD` (key) | **tradeable** |
| RENDER | `FTfbBSVcAbN9XhkYV4N9m4zqVB8jALsUkTnv7vmuhZnG` | 5x | $68k | $125k / $111k | 14.8 bps | 0.07% / 0.10% | `Crypto.RENDER/USD` (free on-chain) | **tradeable** |
| LIT | `CuEkf4SopwRHsdYfTy5zE5aohcWXmFh693Fb99nueJ4r` | 5x | $60k | $139k / $140k | 3.5 bps | 0.02% / 0.03% | `Crypto.LIT/USD` (free on-chain) | **tradeable** |
| VVV | `5kPZcErZ12YbqhUHzguCgYyjMVHxpiMAW324KL2jWVHQ` | 5x | $53k | $97k / $98k | 5.9 bps | 0.03% / 0.06% | `Crypto.VVV/USD` (key) | **tradeable** |
| ADA | `5A8he2Jx5BN8vYgB2Q6uyjemz33gEbEGxacyqXy6va8q` | 10x | $52k | $131k / $132k | 7.9 bps | 0.04% / 0.06% | `Crypto.ADA/USD` (key) | **tradeable** |
| ORCA | `Cm5wBBtANNaMVjujv7pvzFnKNSDeqeQ5DfnnjnuehX62` | 5x | $49k | $21k / $11k | 15.5 bps | 0.15% / 0.33% | `Crypto.ORCA/USD` (free on-chain) | **tradeable** |
| MEGA | `6KS7HgwRHZG47d7yJgVQrEJQv3jVCrBwDDRxK3YFCMV4` | 5x | $47k | $21k / $62k | 46.2 bps | 0.23% / 0.33% | `Crypto.MEGA/USD` (key) | **tradeable** |
| PUMP | `EwveokQBpaTiGkwCHm2yVdwogHm26PRwponFDt7EjEhz` | 10x | $46k | $132k / $133k | 3.7 bps | 0.02% / 0.04% | `Crypto.PUMP/USD` (free on-chain) | **tradeable** |
| CRV | `BCVSk4zyh5grRWRzMiDn75rqYmKZ9y99KcyrYGyeMTmK` | 10x | $46k | $121k / $123k | 9.9 bps | 0.05% / 0.08% | `Crypto.CRV/USD` (key) | **tradeable** |
| kBONK | `3buzmSTXNBCqkheACHT1epmxNYP3GwMKCFEZiXLwbNrk` | 10x | $45k | $60k / $61k | 8.6 bps | 0.04% / 0.11% | none | **tradeable** |
| ZRO | `7hWzmBJJTMNe5zWeiRbfo1bJ6FEhKUnJGpa1ficR6RWj` | 5x | $45k | $67k / $68k | 15.7 bps | 0.08% / 0.12% | `Crypto.ZRO/USD` (key) | **tradeable** |
| DOGE | `Hqt5Vom5L3X3RcKysKnBmLAvjYgo6TGAwoheW658h5cz` | 10x | $41k | $166k / $168k | 2.4 bps | 0.01% / 0.03% | `Crypto.DOGE/USD` (key) | **tradeable** |
| kSHIB | `9kGYga7xtQbYr8MZtHXj5TVNqTZVUf8xhcCQGoFfBTjE` | 10x | $36k | $59k / $59k | 5.3 bps | 0.03% / 0.07% | none | **tradeable** |
| XRP | `CwaHtR69D287PLnoX8zzzk1zqwNQKVJiJQTNs6JrVyna` | 15x | $34k | $41k / $41k | 20.9 bps | 0.10% / 0.17% | `Crypto.XRP/USD` (key) | **tradeable** |
| AAVE | `A6CdPuNY3mp4tsY1ifQoesHKfwYdVv3wqcaKirEGtaMS` | 10x | $31k | $130k / $131k | 1.8 bps | 0.01% / 0.03% | `Crypto.AAVE/USD` (free on-chain) | **tradeable** |
| VIRTUAL | `4vAnWXWaoGCS54S6LWUxfeyNyER7SjgWx17riAuoNQPe` | 5x | $30k | $129k / $130k | 5.2 bps | 0.03% / 0.05% | `Crypto.VIRTUAL/USD` (key) | **tradeable** |
| ARB | `7zHdoSkEhNHb7oKTUCfJTnPr83N7DzVXQ8Bk6SgPdujM` | 15x | $29k | $123k / $125k | 15.4 bps | 0.08% / 0.10% | `Crypto.ARB/USD` (key) | **tradeable** |
| TRX | `FksNfo3SvhtTZcAJUGT2fviTbrocavYAPgT4iK8YRkMr` | 10x | $29k | $148k / $149k | 3.3 bps | 0.02% / 0.03% | `Crypto.TRX/USD` (free on-chain) | **tradeable** |
| TAO | `CoshgxCZygQnS5jJLi24DkuJN4hddRNdPVSmTWrURbHu` | 5x | $28k | $66k / $67k | 10.5 bps | 0.05% / 0.08% | `Crypto.TAO/USD` (free on-chain) | **tradeable** |
| LTC | `HFYNBdwXP1BrnD7eLx7B3NGHi3VqEHdTkQH9FhEUFa8n` | 10x | $26k | $150k / $151k | 2.7 bps | 0.01% / 0.03% | `Crypto.LTC/USD` (key) | **tradeable** |
| CHIP | `7kqxngbXdGsshqN6btUihJsKDJVXPe7ZENk8EAe41bjN` | 5x | $26k | $32k / $33k | 21.4 bps | 0.11% / 0.17% | `Crypto.CHIP/USD` (key) | **tradeable** |
| SUI | `GQS3qn9EjKYpqoLwpvPVbeW9o1bjFYhc1SRMZYw4iNru` | 10x | $26k | $181k / $183k | 2.2 bps | 0.01% / 0.02% | `Crypto.SUI/USD` (free on-chain) | **tradeable** |
| FET | `CZCsCBxHca5LPFd4gEZBi9oSeYYH9fcUJzE45b3raQPN` | 5x | $26k | $66k / $67k | 15.5 bps | 0.08% / 0.12% | `Crypto.FET/USD` (key) | **tradeable** |
| ONDO | `D1Zzj55T5b4yXF4x7nHpSMVXGZ8xGAnmEqYCzh1ZZHDM` | 10x | $24k | $96k / $97k | 6.7 bps | 0.03% / 0.06% | `Crypto.ONDO/USD` (key) | **tradeable** |
| WLD | `9fpYNmbtByPavdaQ6NV141aUyYLvcrBnNA6FDkh5aGp8` | 10x | $24k | $123k / $124k | 8.5 bps | 0.04% / 0.07% | `Crypto.WLD/USD` (key) | **tradeable** |
| FIL | `C4KtLwSPjchkbmD3H2kuW7mzLhgKpaYbh15PRqzUPsUe` | 5x | $22k | $60k / $60k | 10.3 bps | 0.05% / 0.09% | `Crypto.FIL/USD` (key) | **tradeable** |
| XLM | `AXewQALSfgppjhfsZ6w5pqV7wNR5ShDRXPPTy7yx7yuE` | 5x | $21k | $129k / $131k | 7.3 bps | 0.04% / 0.05% | `Crypto.XLM/USD` (key) | **tradeable** |
| FARTCOIN | `ERTPfrA1VzpnefeGWUtoWRuE9r8wak5KL3Mm4EYCVgc7` | 10x | $14k | $124k / $126k | 11.4 bps | 0.06% / 0.08% | `Crypto.FARTCOIN/USD` (free on-chain) | **tradeable** |
| AERO | `6KuE4PVkcowHXNpHH8W3z3Co8FSXqYNRrvfnHWqTU7GD` | 3x | $12k | $41k / $42k | 16.2 bps | 0.09% / 0.15% | `Crypto.AERO/USD` (key) | **tradeable** |
| JTO | `AJCsYQYT9ezpdcq28yzVkXos5RKhaWrRbDFASgJxNtu9` | 5x | $11k | $67k / $68k | 8.0 bps | 0.04% / 0.09% | `Crypto.JTO/USD` (free on-chain) | **tradeable** |
| ORE | `EuMeE1dTEBg1crFTnub6RCrBi1tMauXciCkiuPAbpwXj` | 3x (isolated) | $9k | $1k / $1k | 9.5 bps | 0.35% / 0.60% | `Crypto.ORE/USD` (free on-chain) | **tradeable** |
| RAY | `GjjXL4ZG2jSS8sF2vA9eUZg2t7Hoa7Z3YfSp2Q3km3kS` | 5x | $8k | $21k / $11k | 15.7 bps | 0.15% / 0.33% | `Crypto.RAY/USD` (free on-chain) | **tradeable** |
| MET | `HxhDqvdDJ9qWaWJ5tvMEdyL1CvZmnBtqA5PTRLyr7CB` | 5x | $8k | $10k / $22k | 46.4 bps | 0.23% / 0.32% | `Crypto.MET/USD` (free on-chain) | **tradeable** |
| ANSEM | `3X4TMR17aZLp9hzK4UZ7YkhHbeCTpVwsQZLA6X11vcAk` | 3x (isolated) | $6k | $994 / $1k | 62.2 bps | 0.31% / 0.50% | `Crypto.ANSEM/USD` (key) | **tradeable** |
| STONK | `zZvkfVnUiRd2MU9t9Uzthk4CcnZi3kmwAG5pdwGZuoM` | 3x (isolated) | $6k | $1k / $1k | 75.2 bps | 0.38% / 0.60% | `Crypto.STONK/USD` (key) | **tradeable** |
| LINK | `U33LNenCZH4dZpHyfvcBFGEcvPZ3AsWfLkjhspiEoLK` | 10x | $6k | $177k / $179k | 2.2 bps | 0.01% / 0.02% | `Crypto.LINK/USD` (free on-chain) | **tradeable** |
| ENA | `CQJduVF57Eycp6M6fPDv5GBUR2TL5cCiriaLBhoCz4dj` | 10x | $2k | $124k / $125k | 8.8 bps | 0.04% / 0.07% | `Crypto.ENA/USD` (key) | **tradeable** |
| AVAX | `8sd8Di5kn94xWXjDGZNQ3wAH1SWjsoLBoY639j9yZN53` | 10x | $1k | $125k / $127k | 5.7 bps | 0.03% / 0.05% | `Crypto.AVAX/USD` (key) | **tradeable** |
| UNI | `4PgqjUyALHjN8fF6VUBAD9peWmYagqaQb1WhgwqJ88Xd` | 10x | $1k | $154k / $156k | 4.2 bps | 0.02% / 0.04% | `Crypto.UNI/USD` (key) | **tradeable** |
| SKR | `HnKUNWrcrpYqK5Uworv2wH6Ki3ciDVDDYqicE5SRAAWs` | 3x (isolated) | $1k | $6k / $8k | 44.8 bps | 0.31% / 0.37% | `Crypto.SKR/USD` (key) | **tradeable** |
| METADAO | `ERbMYSHzmvNeYxCdQtgPzsfUZ2qKuh9ZuvkCsbQCZXYv` | 3x (isolated) | $992 | $943 / $958 | 9.8 bps | 0.42% / 0.81% | none | **tradeable** |
| DRV | `Cte542VgZTH4dy2upy32UXBUxarUqu8aTUF4PEkMXWYo` | 3x (isolated) | $162 | $24k / $26k | 3.0 bps | 0.06% / 0.22% | none | **tradeable** |
| PONS | `Cv9UFv5i3J3S7hJMQaMKvVZGc5cm9g1EHJWm9zzCo2u9` | 3x (isolated) | $11 | $60k / $61k | 9.1 bps | 0.05% / 0.10% | `Crypto.PONS/USD` (key) | **tradeable** |

## USDC yield

_Measured 2026-11-17T18:33:19.307Z._ Kamino lists 112 USDC Earn vaults; the top ones by TVL are below, with Jupiter Lend's USDC Earn. Deposits come from the user's wallet in the same transaction as our receipt.

| Venue | Vault | Address | Share mint | TVL | APY now | APY 7d | APY 30d | Fees | Note |
|---|---|---|---|---|---|---|---|---|---|
| Jupiter Lend Earn | jupiter lend USDC | `9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D` | `9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D` | $464.5M | 4.15% | – | – | supplyRate 390, rewardsRate 25 | totalRate read as basis points (550 = 5.50%); unit unverified in Jupiter docs |
| Kamino Earn | Kamino Institutional Commodity Yield | `B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6` | `2bnxGUrAevL2i9zYtJWwPnAE2RmiPpRxjYnwv886DGCC` | $49.6M | 7.61% | 7.59% | 7.74% | perf 0 bps, mgmt 0 bps | Kamino metrics API returns APY as a fraction; shown as % |
| Kamino Earn | RWA USDC | `DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP` | `DgHN3q3dSYAchNX7V3D4aYiTWMx8RHTgHbfPiwiqBkE9` | $44.9M | 5.75% | 6.34% | 5.97% | perf 500 bps, mgmt 0 bps | Kamino metrics API returns APY as a fraction; shown as % |
| Kamino Earn | Steakhouse USDC | `HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E` | `7D8C5pDFxug58L9zkwK7bCiDg4kD4AygzbcZUmf5usHS` | $15.4M | 3.33% | 3.57% | 4.50% | perf 500 bps, mgmt 0 bps | Kamino metrics API returns APY as a fraction; shown as % |
| Kamino Earn | Plume x Re7 USDC | `HJFEPRRRLBfJBfSJaC69r3nMYskViL9Yy1QLLAqjvnW` | `BVPfgxUyzw8xYSq9ZvuKnRpr3Czoixnz5pCK5Xj69WEh` | $9.7M | 5.43% | 8.68% | 8.75% | perf 1000 bps, mgmt 0 bps | Kamino metrics API returns APY as a fraction; shown as % |
| Kamino Earn | Allez USDC | `A1USdzqDHmw5oz97AkqAGLxEQZfFjASZFuy4T6Qdvnpo` | `BDh5h1uqhdL3pdCcTB1AEc2dyRsorDx9fF8Y72H1XZu8` | $9.6M | 4.56% | 5.68% | 5.90% | perf 500 bps, mgmt 0 bps | Kamino metrics API returns APY as a fraction; shown as % |
| Kamino Earn | Kamino Private Credit USDC | `91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy` | `B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe` | $7.3M | 7.52% | 7.54% | 7.58% | perf 0 bps, mgmt 0 bps | Kamino metrics API returns APY as a fraction; shown as % |
| Kamino Earn | Elemental USDC Turbo | `A3hTCWdnfV6uiQLxRmnv17EpiEtmc93v1AGQnWy44Mup` | `EzqBwrAebfhRNZw6nxFK4vaEhKCSeQPL36FZeUB9PsJA` | $2.9M | 7.32% | 6.79% | 7.11% | perf 0 bps, mgmt 25 bps | Kamino metrics API returns APY as a fraction; shown as % |
| Kamino Earn | Galaxy USDC | `ADcgKvst9u9qRXgSCxg2eZtqKNYPuMbfqjntaLepxwE5` | `3aKWfLSwX83NxEL5BJvCV81wHKjDWDd8NKaEx7x7bYm1` | $2.1M | 4.14% | 4.55% | 4.97% | perf 0 bps, mgmt 25 bps | Kamino metrics API returns APY as a fraction; shown as % |

Sources: <https://lite-api.jup.ag/lend/v1/earn/tokens>, <https://developers.jup.ag/docs/api-reference/lend/earn>, <https://api.kamino.finance/kvaults/vaults>, <https://api.kamino.finance/kvaults/{vault}/metrics>, <https://kamino.com/docs>.

## Collector Crypt cards

_Measured 2026-11-17T18:33:19.307Z._ 196,369 cards indexed; **14,875 listed for sale** (10,981 on Collector Crypt itself, the rest mirrored from Magic Eden). Token standard: Metaplex Core and programmable NFTs (pNFT); the marketplace program also supports compressed and legacy NFTs; in the 10,981 Collector Crypt listings scanned: pnft 4012, core 6888, nft 79, cnft-v2 2. Listing currency: USDC 10981. Median insured value $50 (90th percentile $300). Marketplace program `CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr`.

- Prices come only from the Collector Crypt API (listing price, insuredValue): no on-chain oracle, so a trusted settler must sign card prices.
- Listings are escrowless 1/1 NFTs: each card is its own market with exactly one unit.
- **How to fetch the current list:** GET https://api.collectorcrypt.com/marketplace?listPriceMin=0.000001&marketplaceSource=CC&step=200, then follow nextCursor until null (no key; optional Bearer ccsk_ key raises limits). Single card: GET https://api.collectorcrypt.com/cards/publicNft/{cardId}/market

| Category | Listed | Priced in USDC | Min | Median | 90th pct | Max |
|---|---|---|---|---|---|---|
| Pokemon | 8908 | 8908 | $13.00 | $83.00 | $989.00 | $2,000,000.00 |
| One Piece | 1136 | 1136 | $15.31 | $120.00 | $500.00 | $2,000,000.00 |
| Dragon Ball | 208 | 208 | $30.40 | $145.00 | $599.00 | $12,999.00 |
| Riftbound | 126 | 126 | $40.00 | $165.00 | $689.00 | $25,000.00 |
| Moonbirds | 125 | 125 | $15.00 | $80.00 | $500.00 | $15,000.00 |
| Marvel | 87 | 87 | $13.50 | $30.00 | $150.00 | $1,000.00 |
| (uncategorised) | 78 | 78 | $11.00 | $50.00 | $1,250.00 | $30,000.00 |
| Soccer | 57 | 57 | $24.99 | $100.00 | $600.00 | $5,000.00 |
| Collectible Card Games | 32 | 32 | $15.00 | $100.00 | $9,999.00 | $19,999.00 |
| Azuki | 31 | 31 | $350.00 | $350.00 | $432.00 | $700.00 |
| Basketball | 29 | 29 | $15.00 | $250.00 | $639.00 | $5,000.00 |
| Vibes | 23 | 23 | $32.00 | $250.00 | $1,500.00 | $10,500.00 |
| Non-Sport | 21 | 21 | $25.00 | $249.00 | $45,000.00 | $1,000,000.00 |
| Lorcana | 17 | 17 | $35.00 | $100.00 | $1,500.00 | $1,588.00 |
| Yu-Gi-Oh! | 17 | 17 | $40.00 | $295.00 | $599.00 | $625.00 |
| Football | 15 | 15 | $15.00 | $85.00 | $495.00 | $4,100.00 |
| Baseball | 14 | 14 | $15.00 | $149.00 | $2,500.00 | $3,000.00 |
| Naruto | 13 | 13 | $99.00 | $255.00 | $799.00 | $1,999.00 |
| DC | 12 | 12 | $20.00 | $65.00 | $65.00 | $75.00 |
| Watch | 7 | 7 | $200.00 | $240.00 | $1,000.00 | $1,000.00 |
| Gundam | 5 | 5 | $86.40 | $107.20 | $444.40 | $444.40 |
| Hockey | 5 | 5 | $55.71 | $555.55 | $3,600.00 | $3,600.00 |
| Union Arena | 5 | 5 | $30.00 | $90.00 | $100.00 | $100.00 |
| Sports | 3 | 3 | $19.99 | $20.50 | $29.99 | $29.99 |
| Magic The Gathering | 2 | 2 | $57.20 | $150.00 | $150.00 | $150.00 |
| Nobody Sausage | 2 | 2 | $174.00 | $348.00 | $348.00 | $348.00 |
| Boxing & MMA | 1 | 1 | $488.00 | $488.00 | $488.00 | $488.00 |
| Playmat | 1 | 1 | $40.00 | $40.00 | $40.00 | $40.00 |
| Incursion | 1 | 1 | $6,900.00 | $6,900.00 | $6,900.00 | $6,900.00 |

Sources: <https://api.collectorcrypt.com/marketplace>, <https://docs.collectorcrypt.com/marketplace/api>, <https://docs.collectorcrypt.com/marketplace/program>.

## Gemini prediction markets (custodial)

_Measured 2026-11-17T18:33:19.307Z._ Custodial: Thesis's own Gemini account places every order; users never link Gemini. Orders need Gemini API credentials and acceptance of the prediction-markets terms (POST /v1/prediction-markets/terms/accept). Nothing is on-chain; resolution follows each contract's terms PDF. Regulated venue and US availability are unverified. 1,259 active events. The categories endpoint lists: Live, Sports, Crypto, Commodities, Economics, Economy, Fun/Culture, Media, Politics, Tech, Business, Weather, Culture, Other, Finance.

- **How to list them:** GET https://api.gemini.com/v1/prediction-markets/categories, then GET https://api.gemini.com/v1/prediction-markets/events?status=active&category=<name>&limit=100&offset=<n> (pagination.total gives the count). Contracts carry instrumentSymbol, prices.buy/sell.yes/no, expiryDate and termsAndConditionsUrl.

| Category | Active events | Contracts | Total volume | 24h volume | Busiest events (24h) |
|---|---|---|---|---|---|
| Sports | 1000 | 12538 | $617k | $46k | Utah vs Los Angeles L (`NBA-2611190300-UTA-LAL-M`); Charlotte vs Los Angeles L (`NBA-2611180400-CHA-LAL-M`); Portland vs Minnesota (`NBA-2611180100-POR-MIN-M`) |
| Crypto | 102 | 368 | $265k | $42k | BTC price on November 17 (`BTC2611172200`); BTC price on November 20 (`BTC2611202200`); SOL price on November 17 (`SOL2611172200`) |
| Weather | 98 | 644 | $661 | $261 | Highest temperature in Chicago on November 17, 2026? (`WXHIGH-CHI-2611180459`); Highest temperature in Houston on November 17, 2026? (`WXHIGH-HOU-2611180459`); Highest temperature in Miami on November 17, 2026? (`WXHIGH-MIA-2611180459`) |
| Politics | 20 | 241 | $1.6M | $726 | Presidential Election Winner 2028? (`PRES2028`); Who will leave the Trump Administration in 2026? (`CABINET-26`); Which world leaders will leave office in 2026? (`LEAVE2026`) |
| Commodities | 18 | 198 | $22k | $20k | Oil (Brent) price on November 17? (`BRENT2611172200`); Gold price on November 17? (`XAU2611172200`); Oil (WTI) price on November 17? (`WTI2611172200`) |
| Economics | 9 | 108 | $623k | $960 | When will traffic at the Strait of Hormuz return to normal? (`HORMUZNORMAL`); Fed decision in December? (`FED261211`); Recession this year? (`RECESSION26`) |
| Business | 6 | 36 | $310k | $337 | Which companies will the US take a stake in before 2027? (`USSTAKE`); When will Stripe announce an IPO? (`STRIPEIPO`); Will GameStop acquire eBay? (`GMEEBAY`) |
| Tech | 3 | 10 | $352k | $451 | Best AI at the end of 2026? (`BESTAI26`); NASA lands on the moon? (`NASAMOON`); Zcash Orchard pool vulnerability proven not exploited by Dec 31, 2026? (`ZECEXPLOIT26`) |
| Culture | 3 | 43 | $19k | $250 | Dune: Part Three: Rotten Tomatoes Score (`DUNEPART3RT`); Avengers Doomsday: Rotten Tomatoes Score (`AVENGERSDOOMSDAYRT`); The Game Awards: 2026 Game of the Year (`GOTY2026`) |

Volume is Gemini's `volume` field, read as USD (unit unverified). Sources: <https://api.gemini.com/v1/prediction-markets/categories>, <https://api.gemini.com/v1/prediction-markets/events>, <https://developer.gemini.com/specs/openapi/prediction-markets.yaml>.

## Good basket candidates

Liquid enough for a one-signature leg today, grouped by theme. Spot means tradeable on Jupiter ($100 buy under 1%) **and** a $1,000 buy under 2%, which drops tiny order books that fill $100 and then run out. Perp means a Phoenix market where a $1,000 buy fills within 1% of mid. Perps are closed to US users and need Phoenix onboarding; xStocks are closed to US persons. Tradeable assets with no theme mapping in `curated.ts` are not listed here.

| Theme | Spot (cost of a $100 buy) | Phoenix perps (max leverage) |
|---|---|---|
| AI and compute | NVDAx (0.09%), NVDA (0.23%), tOpenAI (0.44%), MSFTx (0.14%), METAx (0.15%), GOOGLx (0.00%), AMZN (0.16%), AMZNx (0.19%), GOOGL (0.30%), META (0.28%), AMD (0.36%), MSFT (0.12%), AVGOx (0.09%), PLTRx (0.56%), MU (0.68%), SKHY (0.36%), SNDK (0.71%), INTCx (0.39%), DRAM (0.08%), TSM (0.17%), DELL (0.25%), ARM (0.46%), AVGO (0.51%), INTC (0.84%) | NBIS (10x), AVGO (10x), MRVL (10x), INTC (10x), SNDK (15x), ARM (10x), IREN (10x), AMAT (10x), AMD (10x), AMZN (20x), GOOGL (20x), TSM (10x), ORCL (10x), MSFT (20x), PLTR (10x), ANTHROPIC (6x), CBRS (10x), META (20x), SKHY (10x), NET (10x), KLAC (5x), DELL (10x), CRWD (10x), ASML (10x), MU (15x), NVDA (20x), CRWV (10x), QCOM (10x) |
| Consumer and media | TTWO (0.20%), TSLAx (0.10%), AAPLx (0.07%), TSLA (0.19%), MCDx (0.07%), AMC (1.00%), DKNG (0.37%), NKE (0.40%), AAPL (0.18%), COST (0.44%), RBLX (0.62%), SNAP (0.56%), LULU (0.24%), SHOP (0.14%), DNUT (0.55%), CMG (0.30%) | TSLA (20x), AAPL (20x), NFLX (10x) |
| Crypto-adjacent | CRCLx (0.11%), MSTRx (0.49%), GMEx (0.12%), COINx (0.25%), tKalshi (0.43%), BOT (0.52%), HOODx (0.00%), MSTR (0.89%), HOOD (0.54%) | MSTR (10x), HOOD (10x), CRCL (10x), COIN (10x) |
| Index and macro | SPYx (0.01%), QQQx (0.13%), QQQ (0.18%), SQQQ (0.52%), UVXY (0.08%), SCHH (0.56%), EWZ (0.08%), SPY (0.48%) | TLT (20x), QQQ (20x), SPY (20x) |
| Commodities | GLDx (0.08%), XAUt0 (0.12%), GOLD (0.46%), VNXAU (0.35%), XAUM (0.51%), PAXG (0.10%) | WTIOIL (20x), GOLD (25x), SILVER (25x), COPPER (20x) |
| Space and defense | SPCX (0.00%), SPCXx (0.03%), LMT (0.73%), tSpaceX (0.80%) | SPCX (15x) |
| Healthcare | HIMS (0.33%), LLY (0.47%), PFE (0.14%) | LLY (10x), MRNA (10x) |
| Energy and power | URA (0.55%), PUSA (0.76%) | WTIOIL (20x) |

- **Crypto perps** (tradeable on Phoenix): UNI, ORE, CRV, ARB, kBONK, WLD, DRV, ENA, ANSEM, BNB, FARTCOIN, VIRTUAL, STONK, MON, XPL, XLM, AVAX, SOL, AERO, ZEC, TRX, JTO, LIT, ETH, ADA, PONS, FET, kPEPE, LTC, AAVE, NEAR, TAO, MET, BP, PUMP, VVV, BTC, ZRO, XRP, FIL, JUP, HYPE, CHIP, MORPHO, RAY, LINK, ORCA, ONDO, MEGA, DOGE, METADAO, SUI, RENDER, SKR, kSHIB.
- **Cash leg:** Jupiter Lend Earn jupiter lend USDC ($464.5M TVL, 4.15% APY).
- **Prediction legs (custodial, via Thesis's Gemini account):** Sports (1000), Crypto (102), Weather (98), Politics (20), Commodities (18), Economics (9).

## Unverified

- Ondo Global Markets: exact eligibility terms
- Backpack Securities: holder eligibility
- Remora Markets (rStocks): issuer, backing and eligibility
- Tessera (pre-IPO exposure): issuer, structure and eligibility
- SHIFT RWA (leveraged equity tokens): eligibility
- issuer: not in curated list; name comes from Jupiter token metadata (6 assets)
- issuer and backing (2 assets)
- issuer mapping; matched by name and Jupiter tag (2 assets)
- issuer and gold backing (2 assets)
- eligibility for secondary holders (1 asset)
- issuer mapping and eligibility (1 asset)
- eligibility (1 asset)
- issuer mapping; matched by name (1 asset)
- that this Solana mint is Paxos-issued rather than bridged; matched by name and Jupiter verified tag only (1 asset)
- Gemini's regulated venue and US availability.
- Jupiter Lend's `totalRate` unit (read as basis points).
- The oracle Phoenix uses for equity marks.

## Sources

- <https://lite-api.jup.ag/tokens/v2/tag?query=verified>
- <https://lite-api.jup.ag/swap/v1/quote>
- <https://dev.jup.ag/docs/swap/get-quote>
- <https://lite-api.jup.ag/lend/v1/earn/tokens>
- <https://developers.jup.ag/docs/api-reference/lend/earn>
- <https://perp-api.phoenix.trade/exchange>
- <https://perp-api.phoenix.trade/v1/view/orderbook/{symbol}>
- <https://docs.phoenix.trade>
- <https://github.com/Ellipsis-Labs/rise-public>
- <https://api.kamino.finance/kvaults/vaults>
- <https://api.kamino.finance/kvaults/{vault}/metrics>
- <https://kamino.com/docs>
- <https://api.collectorcrypt.com/marketplace>
- <https://docs.collectorcrypt.com/marketplace/api>
- <https://docs.collectorcrypt.com/marketplace/program>
- <https://api.gemini.com/v1/prediction-markets/events>
- <https://api.gemini.com/v1/prediction-markets/categories>
- <https://developer.gemini.com/specs/openapi/prediction-markets.yaml>
- <https://hermes.pyth.network/v2/price_feeds>
- <https://docs.pyth.network/pro/pyth-core-upgrade.mdx>
- <https://docs.pyth.network/pro/sponsored-feeds>
- <https://solana.com/docs/rpc/http/getmultipleaccounts>
- Per-asset sources (issuer pages, Jupiter token pages, Solscan mint pages) are in `assets.json` under `sources`.
