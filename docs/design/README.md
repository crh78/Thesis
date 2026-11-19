# Thesis — design

Design principles and tokens for the Thesis apps. `assets/` holds the exported images (brand, avatars, topics, the app icon).

## Screens

- **Feed (For you / Following)**
- **New take: claim, risk**
- **AI building the basket (thinking orb + border beam)**
- **Basket donut, risk dial, per-pick explanations, buy in**
- **Take page: chart, basket, traders vs faders, comments (full scroll)**
- **Trade / fade sheets**
- **Comment thread with position badges**
- **iMessage group with the Thesis agent (link preview = take card image)**
- **Search, topics, top callers, trending takes**
- **Scores leaderboard (cash made / return %)**
- **Your profile: score chart, balance, positions, takes, badges**

## Principles

- **Sectionless.** Content sits on the background with hairline dividers (X / Fomo). No cards around content.
- **Glass is for controls only.** Tab bar, floating buttons, sheets, inputs, segmented controls. In SwiftUI use the native Liquid Glass APIs (`.glassEffect()`, `GlassEffectContainer`) instead of recreating the CSS.
- **Trade or fade.** The two sides of every take are "Trade" (go with it) and "Fade" (bet against it): Traded, traders, % trading. Never "Back". (Code still calls the side `.back`.)
- **Crypto is invisible.** No USDC, gas, wallets, chains or venue names in UI. Say "balance", "add cash", "stock", "prediction", "locked".
- **Dark mode by default**, light mode supported.
- **Two scores, no formula**. Own P&L, and what your takes made for the people who traded them. Show dollars and % together; every board can be ranked by either. A third board ranks who made the most from fading. Boards have no minimum stake for % ranking.

## Tokens

### Color (dark / light)

| Role | Dark | Light |
| --- | --- | --- |
| Background | `#07080B` | `#F6F7F9` |
| Text | `#F2F3F5` | `#0F1419` |
| Muted text | `#9AA0AA` | `#535B66` |
| Hairline | `white 9%` | `#0F1419 9%` |
| Up / Trade (text) | `#A6E3B8` | `#1E7A43` |
| Down / Fade (text) | `#F2A9C2` | `#B23A68` |
| Trade button | gradient `#BDEDCB → #97DBAB`, ink `#06210F` | same |
| Fade button | gradient `#F8C8D8 → #EFA5C0`, ink `#330A1A` | same |
| Primary button | clear glass, white text | white glass, dark text |

Basket / chart categorical palette (CVD-validated, keep the order; color follows the pick, not its rank):

| Slot | Dark | Light |
| --- | --- | --- |
| 1 | `#3987E5` | `#2A78D6` |
| 2 | `#D95926` | `#EB6834` |
| 3 | `#199E70` | `#1BAF7A` |
| 4 | `#C98500` | `#EDA100` |
| 5 | `#D55181` | `#E87BA4` |

### Type (Geist family)

| Use | Font |
| --- | --- |
| UI text, big numbers | Geist Sans |
| Take claims (the opinion itself) | Geist Serif, regular weight |
| Data: tickers, weights, amounts, dates, ranks | Geist Mono |
| Wordmark `thesis`, "Called it" | Geist Pixel Square |

For iOS, add the Geist TTF/OTF files from the Geist font release to the Xcode target (the `geist` npm package ships woff2, which iOS can't use).

### Motion

- **Border beam** and **thinking orb** only during the new-take / AI-building moment — never on feed content. SwiftUI: `BorderBeamKit`, `ThinkingOrbsKit` from libraries.dev.
- Charts are scrubbable: drag to read a value; the big number above follows the finger.

## Asset credits

- Avatars: DiceBear "Notionists" style (CC0): the demo people, plus the 33 faces new users pick from (`avatar-person-01…33`). Those have the head's skin tinted to one of six tones and a mix of hair and features so everyone can find themselves, with no props or exaggerated features. `person-12` (Sikh man, dastar) and `person-13` (locs) are drawn by us on Notionists bases. Rebuild with `assets/avatars/source/build_faces.py`.
- Topic images: Microsoft Fluent Emoji 3D (MIT).
- Fonts: Geist by Vercel (SIL Open Font License).
