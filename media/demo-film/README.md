# Thesis demo film

The 2:06 promo, built from two parts:

1. **The reel (0:00–1:08)**: a vertical, stylized 3D "she left him because he was broke → everyone's betting on everything → three bets on Thesis → *Nah. I own the place.* → Bugatti" story. Every shot was generated with Seedance 2.5 on Replicate.
2. **The technical section (1:08–2:06)**: a Remotion film covering the logo, made tradable, risk levels, asset classes, group chat + X, copy trading, back/fade, receipts, badges and the outro.

The finished film is at [`film/out/thesis-film-final.mp4`](film/out/thesis-film-final.mp4): 1920×1080, 30 fps, lo-fi bed, −16 LUFS.

Every video, image and audio file lives in **Git LFS**. Run `brew install git-lfs && git lfs install && git lfs pull` once, or you'll get pointer files.

```
media/demo-film/
├── reel/                      Part 1: Seedance story
│   ├── SCRIPT.md              beat sheet: shots, dialogue, captions
│   ├── shots.json             every prompt: style, reference-image prompts, one entry per shot
│   ├── gen.py                 Replicate runner: reference images (Seedream 4.5) + shots (Seedance 2.5)
│   ├── refs/                  character / set / app-screen references fed to every shot
│   ├── out/480p/              every generated shot: 2 takes of s1–s7, plus the intros i1 (blender), i2 (fryer)
│   ├── out/intro/             intros with the "thesis / social trading for ideas" title burned in
│   ├── out/reel-*.mp4         assembled cuts (take 1, take 2, take 2 + intro = the one in the film)
│   ├── title.sh               burns the title onto an intro clip
│   ├── build-reel.sh          cuts the reel from chosen takes → film/public/reel.mp4
│   ├── music.py               music beds (Lyria 2 on Replicate)
│   ├── music/                 1-launch, 2-lofi (used), 3-cinematic
│   └── app/                   raw simulator recording of the take flow
├── film/                      Part 2: Remotion project (the whole film renders from here)
│   ├── src/Film.tsx           timeline: reel → fade → SECTIONS (scene order + length in frames)
│   ├── src/scenes.tsx         one component per scene
│   ├── src/ui.tsx             shared pieces: Background, Headline, Tech caption, Phone, Donut, Brand logos…
│   ├── src/Badge.tsx          the hexagon "called it" medallions (TIERS)
│   ├── src/Logo.tsx           pixel logo assembling + wordmark (rects in logo.json)
│   ├── src/theme.tsx          colors, fonts, easing
│   ├── public/                fonts, app screenshots, share cards, brand marks, reel.mp4
│   └── mix.sh                 music bed + loudness pass over a render
└── ios-demo/                  app patches used only to film the app (don't merge)
```

## Editing the technical section (Remotion)

```
cd media/demo-film/film
npm ci
npm run studio        # live preview: the "Film" composition is everything, "Tech" is just part 2
npm run render        # renders out/film-nomusic.mp4, then mix.sh → out/thesis-film-final.mp4 (~7 min on an M-series Mac)
```

- **Reorder, cut or retime scenes:** edit `SECTIONS` in `src/Film.tsx`. Lengths are in frames at 30 fps, and the total updates itself. Each scene fades in and out through `<Scene>`, and there's a 36-frame fade from the reel to black.
- **Change copy:** headlines are `<Headline a="…" b="…">` (the second line is green). The mono line along the bottom is `<Tech items={[…]}>`. Both are in `src/scenes.tsx`, one component per scene:

| Scene | Component | What's on screen |
|---|---|---|
| logo | `LogoScene` | 82 pixel squares fly in and snap into the mark, then avatars pop in and "thesis" types out |
| tradable | `TradableScene` | "Your ideas, made tradable": a take → a 5-pick basket, plus the app's money screen |
| risk | `RiskScene` | "Any idea. Any risk level.": one take ("AI is on the rise") at low/medium/high; changed rows highlight |
| assets | `AssetScene` | "Any asset class": stocks, pre-IPO, prediction markets, perps, yield, collectibles; each gets its own visual, then they collapse into a donut |
| chat | `ChatScene` | iMessage group-chat bot + X reply bot drafting takes |
| copy | `CopyScene` | copy trading (@macromike, gold) |
| social | `SocialScene` | comments, back / fade |
| receipt | `ReceiptScene` | the app's on-chain receipt + a fan of the real share cards |
| badges | `BadgeScene` | soulbound "called it" badges (`src/Badge.tsx`) |
| outro | `OutroScene` | end card |

- **Logos:** `<Brand k="NVDA" />` loads `public/img/marks/NVDA.svg`, or `.png` for the keys listed in `PNG` in `src/ui.tsx`. Add a transparent mark there to use a new ticker.
- **Share cards** (`public/img/cards/`) were rendered by the app's own `ThemedCard` with `ios-demo/render-cards.patch`.
- **Rendering:** if Remotion's bundled browser crashes ("Target closed"), `remotion.config.ts` already switches to installed Google Chrome when it finds one.

## Music and levels

`film/mix.sh [in] [out] [music]` loops the 33 s clip 4 times with 1.5 s crossfades.

- **Under the reel:** the bed sits at **13%**, so the dialogue reads.
- **The ramp:** it rises to **70%** from 67 s to 69.5 s, as the reel fades out.
- **Fades:** 1.5 s fade in, 3.5 s fade out.
- **Loudness:** normalized to −16 LUFS (the raw mix is around −27, which is too quiet).
- **Overrides:** `LOW=0.1 HIGH=0.8 RAMP_AT=67 ./mix.sh …`. Swap the track with the third argument (`../reel/music/1-launch.wav` or `3-cinematic.wav`).

This step re-uses an existing render, so changing the music takes about 10 seconds.

## Editing the reel (Seedance)

The shots are already generated, so most edits are free re-cuts:

```
cd media/demo-film/reel
./build-reel.sh                    # take 2 of every shot (what's in the film)
PICK="s1=1 s6=1" ./build-reel.sh   # mix takes per shot
```

- **What the script does:** it re-encodes each shot to one format, joins them with the concat demuxer, adds the muted blender intro and the "6 months later" card, and copies the result to `film/public/reel.mp4`.
- **If the length changes,** update `REEL` in `film/src/Film.tsx` (seconds × 30) and `RAMP_AT` in `mix.sh`.
- **Don't join with one big ffmpeg filter:** that scrambled the audio, and every shot played s1's sound.

### Generating new shots (costs money)

```
export REPLICATE_API_TOKEN=r8_…          # or keep it in the macOS Keychain as "replicate-api-token"
python3 gen.py cost --res 720p --takes 1  # price check first
python3 gen.py shots --only s6 --takes 2  # new takes of one shot (existing files are skipped)
python3 gen.py shots --res 720p           # 720p finals of everything (~$14)
python3 gen.py refs [--force]             # reference images; him.jpg is the style source and is never overwritten
```

- **Prices:** Seedance 2.5 costs about $0.10/s at 480p and $0.23/s at 720p. Seedream reference images are about $0.04 each. All 480p drafts (2 takes) were about $12.
- **Prompts:** every shot prompt is in `shots.json`. `{him}`, `{her}`, `{newguy}`, `{place}`, `{app-bet}` and `{app-money-N}` become `[ImageN]` references to the files in `refs/`, and the shared `style` block is appended to every shot.
- **Rate limits:** Replicate throttles to 6 requests/min while the account has under $5 of credit, and `gen.py` waits and retries on a 429. Requests without a User-Agent get a Cloudflare 403. `gen.py` sends one.

## Filming the app (`ios-demo/`)

The app shots were recorded on the simulator with two **DEBUG-only** patches. Apply them on a throwaway branch and never merge them:

- **`demo-build.patch`:** the take "Everyone is betting on everything" always builds the fixed Kalshi / DraftKings / Polymarket / Coinbase / Robinhood basket. The balance is pinned, with `-demoBalance 1250000 -demoGain 1150000` as launch args. The profile chart is a smooth demo week.
- **`render-cards.patch`:** launch with `-renderCards` to write every share-card look to the app's `Documents/cards/`.

The patches were cut against the pre-move repo, so they may need a small rebase. Recordings were made with `axe record-video`. On the simulator, `simctl io recordVideo` can fail with "Host recording is already in progress".

## Notes

- **Mock data:** all numbers, chats, X posts, comments, handles (@macromike, @dev) and returns in the film are illustrative mock-ups, not real users or results.
- **Fed photo:** the prediction-market visual uses a photo by AgnosticPreachersKid, CC BY-SA 3.0, credited on screen.
- **Logos:** company and market logos are trademarks of their owners, used to show what's tradable.
- **Fonts:** Geist (OFL).
