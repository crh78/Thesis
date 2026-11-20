# Thesis demo film

The Thesis promo: a stylized 3D story made with Seedance, then a walkthrough of the app made in Remotion. Everything needed to rebuild or change it is here: prompts, generated takes, references, the Remotion code and the build scripts.

| Cut | File | Length | What it is |
|---|---|---|---|
| **Current (16:9)** | `film/out/thesis-film-full.mp4` (built, not committed) | 3:19 | The cinematic story with captions (0:00–1:21), then an 8-step walkthrough of the app (1:21–3:19). Build it with `./build-film.sh`. |
| Earlier 16:9 story | [`film/out/thesis-film-walkthrough.mp4`](film/out/thesis-film-walkthrough.mp4) | 1:03 | An early cut of the 16:9 story on its own, without the walkthrough. It isn't the current film. |
| Original (vertical story) | [`film/out/thesis-film-final.mp4`](film/out/thesis-film-final.mp4) | 2:06 | The vertical "I own the place" reel, then the first Remotion technical section with a lo-fi bed. Kept as it was; see [The original cut](#the-original-cut). |

All are 1920×1080 at 30 fps. The current cut has no music in the repo (see **Sound** under Part 2).

**Git LFS:** every video, image and audio file lives in Git LFS. Run `brew install git-lfs && git lfs install && git lfs pull` once, or you'll get pointer files.

## Quick start

Needs ffmpeg, node, and python3 with Pillow (`pip install pillow`) for the captions and the "Six months later." card.

```
cd media/demo-film/film && npm ci && cd ..
./build-film.sh             # full 1080p film → film/out/thesis-film-full.mp4
./build-film.sh --preview   # 720p preview → film/out/thesis-film-preview.mp4
```

- **To change the walkthrough,** edit `film/src/Guide.tsx` and run `./build-film.sh` again. Only the walkthrough re-renders; the story is rebuilt with ffmpeg in about a minute.
- **To change one step,** run `SCENE=Buy ./build-film.sh`. It re-renders only that step's frames and splices them into the cached render. This only works if the step's length is unchanged.
- **To change the story,** swap or re-cut a shot in `film/public/shots/` and run `./build-film.sh --story-only`, or the full build. The cached walkthrough is reused.
- **To change a caption,** edit `captions.json` (`[start, end, text]`, seconds into the story; `\n` makes two lines) and rebuild. If a shot's length changes, the captions after it move with it, so shift their times too.
- **To preview live,** run `cd film && npm run studio`:
  - `Guide` is the walkthrough on its own.
  - `Story` is the story in Remotion (slower than the ffmpeg build, same look).
  - `FullFilm` is both together.
- **When you're happy with a build,** copy `film/out/thesis-film-full.mp4` over `film/out/thesis-film-walkthrough.mp4` and commit it (with git-lfs installed). That's the only file in `film/out/` that git tracks besides the original cut.

## Layout

```
media/demo-film/
├── build-film.sh              the whole 16:9 film: story (ffmpeg) + walkthrough (Remotion, cached) + join
├── story-text.py              draws the "Six months later." card and burns in the captions (Pillow)
├── captions.json              the story's dialogue captions: [start, end, text]
├── composite-s4x.sh / .py     tracks the phone in shot s4x and composites the lock screen onto it
├── reel/                      Seedance: prompts, references, every generated take
│   ├── shots-16x9.json        prompts for the 16:9 story (style, reference images, one entry per shot)
│   ├── shots.json             prompts for the original vertical reel
│   ├── SCRIPT.md              beat sheet of the original vertical reel
│   ├── gen.py                 Replicate runner: reference images (Seedream 4.5) + shots (Seedance 2.5)
│   ├── refs/                  characters, sets, app screens, logos fed to the shots (refs/old: retired versions)
│   ├── out-16x9/480p/         every generated 16:9 take: <id>-<name>-take<N>.mp4
│   ├── out-16x9/intro/        the dish-machine intro with the title burned in (title.sh)
│   ├── build-reel-16x9.sh     a plain 480p cut of the 16:9 takes (quick check; the film uses build-film.sh)
│   ├── title.sh               burns "thesis / social trading for ideas" + "a short film" onto an intro clip
│   ├── out/, build-reel.sh    the original vertical reel's takes and cutter
│   ├── music.py, music/       music beds (Lyria 2 on Replicate)
│   └── app/                   the original cut's raw simulator recording
├── film/                      Remotion
│   ├── remotion.config.ts     render settings (8 tabs, GPU, system Chrome)
│   ├── src/Guide.tsx          the walkthrough: CHAPTERS (steps, notes, spotlights, taps) + the drawn phone screens
│   ├── src/Story.tsx          the story in Remotion (FullFilm); build-film.sh builds the same thing with ffmpeg
│   ├── src/FullFilm.tsx       Story + Guide
│   ├── src/Screens.tsx        phone screens used as Seedance references, and PhoneUI (the s4x lock screen)
│   ├── src/s4x-screen.json    the phone's tracked corners in s4x, frame by frame
│   ├── src/scenes.tsx         the original technical section's scenes (Guide reuses the logo, asset, cards, badges and outro scenes)
│   ├── src/Film.tsx, Insert.tsx  the original cut's timeline, and its group-chat insert
│   ├── src/ui.tsx, theme.tsx, Logo.tsx, Badge.tsx  shared pieces, colors/fonts, the pixel logo, the badges
│   ├── public/shots/          the story's chosen takes, one file per shot (what build-film.sh cuts)
│   ├── public/app/            the real app recording the walkthrough plays
│   ├── public/img/            share cards, brand marks, avatars, photos
│   └── mix.sh                 music bed + loudness pass (written for the original cut)
└── ios-demo/                  app patches used only to film the app (don't merge)
```

## Part 1: the story

About 82 s of stylized 3D, every shot generated with Seedance 2.5 from `reel/shots-16x9.json`:

- **Setup:** he gets dumped for being broke, and notices everyone is betting on everything.
- **The idea:** "Who's actually winning? The house." So he builds the take "everyone is betting on everything" in Thesis.
- **The take pays off:** +$20K, then his phone blows up with people backing and copying him, then +$100K, then +$1.25M.
- **Six months later:** she comes back, and he owns the place.
- **Ending:** "I made my first million. Lemme show you how you can do it too." He drives off. As the street dissolves, his two taillights stay lit, then break apart into the squares of the logo.

The dialogue is captioned (`captions.json`, from Whisper word timings on the built story, checked against the prompts). The TV anchor in s4a and the shouting in s4c aren't captioned, because they aren't clear enough to transcribe.

| Shot | In `film/public/shots/` | Source take (`reel/out-16x9/…`) |
|---|---|---|
| intro (dish machine, titled) | `intro.mp4` | `intro/intro-dish-machine-titled.mp4` (i1c take 1 + `title.sh`) |
| s1 dumped | `s1.mp4` | `480p/s1-dumped-take1.mp4` |
| s2 the pattern | `s2.mp4` | take 2 |
| s3 who wins | `s3.mp4` | take 1 |
| s3b own the house | `s3b.mp4` | take 1 |
| s4a +$20K | `s4a.mp4` | take 1 |
| s4x phone blows up | `s4x.mp4` | take 4 (`s4x-raw.mp4`) with a lock screen composited onto the phone (see below) |
| s4b +$100K | `s4b.mp4` | take 1 |
| s4c +$1.25M | `s4c.mp4` | take 1 |
| "Six months later." | (drawn by `story-text.py`) | |
| s5 she's back | `s5.mp4` | take 3 |
| s6 punchline | `s6.mp4` | take 1 (its last second plays at half speed in the build) |
| s7 first million | `s7.mp4` | take 1 |
| s8 drive off | `s8.mp4` | take 1 |

**Swapping a take:** copy another take over `film/public/shots/<id>.mp4` and rebuild.

**Generating new takes (costs money):**

```
python3 gen.py --config shots-16x9.json cost --res 480p --takes 1   # price check first
python3 gen.py --config shots-16x9.json shots --only s5 --takes 2   # Seedance 2.5 ≈ $0.10/s at 480p
```

Run these from `reel/`. Prices and token setup are under [Generating new shots](#generating-new-shots-costs-money).

**s4x (the phone blowing up):**
- Seedance can't render readable notifications, so the phone's screen is replaced.
- `src/s4x-screen.json` holds the screen's four corners in every frame of the take.
- The `PhoneUI` composition (`src/Screens.tsx`) is the lock screen. Its notifications use the app's real wording.
- **To rebuild it,** run `./composite-s4x.sh` from `media/demo-film/`, then `./build-film.sh`. It needs python3 with `numpy` and `opencv-python-headless`, plus ffmpeg.
  - It renders `PhoneUI` to a PNG sequence, then runs `composite-s4x.py`.
  - The script tracks the blank white screen in every frame: the largest bright region, its convex hull, then 4 corners, smoothed over 5 frames. It writes the corners to `src/s4x-screen.json`; that file is a record only, and Remotion doesn't read it.
  - It warps each `PhoneUI` frame onto the screen, using the white screen as the matte so his thumbs stay in front.
  - It pushes in from 1.0× to 1.45× over the 66 over-the-shoulder frames, upscales to 1080p and keeps the audio.
- **The s4x files in `public/shots/`:**
  - `s4x-raw.mp4`: Seedance take 4, a blank white phone over his shoulder, then his reaction. The source.
  - `s4x-composite.mp4`: the script's output.
  - `s4x.mp4`: what the story uses, a copy of `s4x-composite.mp4`.
  - `s4x-bubbles-take3.mp4`: take 3, with Seedance's own floating bubbles. A fallback, not used.

## Part 2: the walkthrough (`src/Guide.tsx`)

About 1:57 after the story. It follows one take, "Betting apps are taking over", from typing it to getting copied, then shows the cards and badges.

- **One phone stays on screen.** The left column has a step number, a headline, numbered notes and a mono line of technical detail.
- **A spotlight shows what each note is about.** It dims the rest of the phone screen, with a thin outline just outside the area, so nothing covers it. Tap ripples show the taps.
- **What's real:**
  - **Steps 1–3** play the real simulator recording (`public/app/take-flow.mp4`), labelled "Real app · screen recording" on screen. Its raw recording isn't in the repo; `reel/app/` only has the original cut's `take-everyone-betting-raw.mp4`.
  - **The share cards** in the Cards scene were rendered by the app (`ios-demo/render-cards.patch`).
  - **Steps 4–8** (buy sheet, take page, group chat, X, copy) are drawn in `Guide.tsx` to match the app; they aren't recordings.
- **Order** (each step's `label`, which is also what `SCENE=` takes):
  - The logo: the story's taillights break apart into the pixel mark (`LogoScene`, 110 frames)
  - 1 `Say it`
  - 2 `Build`
  - 3 `Tweak`
  - `Any asset` (full-frame; the phone steps aside)
  - 4 `Buy`
  - 5 `Trade` (back or fade)
  - 6 `Chats` (group chat)
  - 7 `X`
  - 8 `Copy`
  - `Cards` (on-chain receipt + card looks)
  - `Badges`
  - End card
- **Editing `CHAPTERS`:**
  - `dur` is in frames at 30 fps.
  - A note's `at` is frames into its step.
  - `hl` is the spotlight box, in fractions of the phone screen (`x`, `y`, `w`, `h`), shown until `until`.
  - `taps` are the ripples.
  - `Screen` is a drawn phone screen and `Side` is a card beside the phone.
  - `full(label, dur, Scene)` drops in a full-frame scene from `scenes.tsx`.
- **The recording's timing:** steps 1–3 play it continuously, starting 2.5 s in (`V0`). A frame `f` into step 1 is `2.5 + f / 30` s of footage. Step 2 starts at 13.0 s and step 3 at 21.5 s.
- **Numbers:** all handles, chats, posts, returns and fees in the drawn screens are illustrative.
- **Sound:** the walkthrough itself is silent. The music on the current cut is a third-party track laid on after the build, outside the repo, so `build-film.sh` gives you the film with only the story's own sound. `mix.sh` was written for the original cut's timing and doesn't fit this one.

## How the build got fast

`build-film.sh` and `film/remotion.config.ts` replaced rendering the whole film through Remotion.

1. **The story doesn't go through Remotion.** It's straight cuts, so ffmpeg builds it from `film/public/shots/*.mp4`:
   - scale to 1080p
   - grade (`eq=contrast=1.06:saturation=1.08`), vignette, grain
   - letterbox with `drawbox`
   - the serif "Six months later." card, drawn by `story-text.py` (Homebrew's ffmpeg has no `drawtext`)
   - the s6 slow-motion tail
   - then the concat demuxer, `loudnorm`, and the captions (`story-text.py captions`, about 2 min at 1080p)

   It used to take about 4–5 min to render the story's ~2,400 frames in Chrome; now it takes 40 s to 2 min.
2. **The Remotion render is cached.** `film/out/guide.mp4` is re-rendered only when something in `film/src`, `film/public/img`, `film/public/fonts` or `film/public/app` is newer than it. Shots, music and story edits don't count.
   - `--tech` forces a re-render.
   - `touch film/out/guide.mp4` skips one when you know a change doesn't affect it.
3. **One scene at a time.** `SCENE=<label>` looks up that step's frame range (`CHAPTERS` in `Guide.tsx`, after the 110-frame logo), renders only those frames with `--frames=A-B`, and splices them into the cached file. It only works when the step's length hasn't changed; after a length change, run a full render. This path hasn't been timed.
4. **Render settings** (`remotion.config.ts`):
   - `setConcurrency(8)`: the Mac has 10 cores, 4 performance and 6 efficiency.
   - `setChromiumOpenGlRenderer("angle")`: Metal on the GPU for the blurs, glows and blend modes.
   - Uses system Chrome, because Remotion's bundled headless shell crashed with "Target closed".
5. **`--preview`** renders at 720p (`--scale=0.6667`) and builds the story at 1280×720 to match. It should be roughly 2× faster, but that hasn't been timed.
6. **The join** starts the walkthrough 3.30 s into s8 with a 0.5 s crossfade, and fades the story's sound out over the same moment. The logo scene's first frames draw two taillights where the car's are at that point (`TAIL` in `src/scenes.tsx`, measured from s8), so the lights carry on through the dissolve and burst into the mark at frame 13. If s8 is swapped, re-measure `TAIL` or the lights will jump.

| Build (measured on an M-series Mac) | Time |
|---|---|
| Before: the whole film through Remotion | about 8–10 min |
| Original technical section, first build after the changes | 4m44s (39 s story + 186 s Remotion + ~30 s join) |
| Original technical section, rebuild with Remotion cached | 1m10s |
| Walkthrough, first full build | 9m12s (124 s story + 387 s Remotion + join) |

- **`COMP=Tech ./build-film.sh`** builds the story with the original technical section instead. `SCENE=` then uses `SECTIONS` in `Film.tsx`.
- **If Remotion's browser crashes** ("Target closed") on a long render, lower the concurrency, e.g. `--concurrency=4`.

<a id="the-original-cut"></a>
## The original cut

The first version, kept as it was: the vertical Seedance reel (`reel/out/`, `reel/SCRIPT.md`) cut by `reel/build-reel.sh` into `film/public/reel.mp4`, then the `Film` composition (reel → fade → `Tech`), mixed with `mix.sh` into `film/out/thesis-film-final.mp4`.

- `npm run render` renders `Film` → `out/film-nomusic.mp4`, then `mix.sh` → `out/thesis-film-final.mp4`, in about 7 min.
- `src/Film.tsx` now plays the 16:9 story (`Story.tsx`) before `Tech`, with a longer asset scene. That doesn't match `thesis-film-final.mp4` any more.

### Editing the technical section (`Tech`)

```
cd media/demo-film/film
npm ci
npm run studio        # live preview: the "Film" composition is everything, "Tech" is just part 2
npm run render        # renders out/film-nomusic.mp4, then mix.sh → out/thesis-film-final.mp4 (~7 min on an M-series Mac)
```

- **Reorder, cut or retime scenes:** edit `SECTIONS` in `src/Film.tsx`. Lengths are in frames at 30 fps, and the total updates itself. Each scene fades in and out through `<Scene>`, and `Tech` fades in over the story's last 12 frames (`HANDOFF`).
- **Change copy:** headlines are `<Headline a="…" b="…">` (the second line is green). The mono line along the bottom is `<Tech items={[…]}>`. Both are in `src/scenes.tsx`, one component per scene:

| Scene | Component | What's on screen |
|---|---|---|
| logo | `LogoScene` | the car's two taillights break into 82 pixel squares that arc into the mark, then avatars pop in and "thesis" types out |
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

### Music and levels

`film/mix.sh [in] [out] [music]` loops the 33 s clip 4 times with 1.5 s crossfades.

- **Under the reel:** the bed sits at **13%**, so the dialogue reads.
- **The ramp:** it rises to **70%** from 67 s to 69.5 s, as the reel fades out.
- **Fades:** 1.5 s fade in, 3.5 s fade out.
- **Loudness:** normalized to −16 LUFS (the raw mix is around −27, which is too quiet).
- **Overrides:** `LOW=0.1 HIGH=0.8 RAMP_AT=67 ./mix.sh …`. Swap the track with the third argument (`../reel/music/1-launch.wav` or `3-cinematic.wav`).

This step re-uses an existing render, so changing the music takes about 10 seconds.

### Editing the reel (Seedance)

The shots are already generated, so most edits are free re-cuts:

```
cd media/demo-film/reel
./build-reel.sh                    # take 2 of every shot (what's in the film)
PICK="s1=1 s6=1" ./build-reel.sh   # mix takes per shot
```

- **What the script does:** it re-encodes each shot to one format, joins them with the concat demuxer, adds the muted blender intro and the "6 months later" card, and copies the result to `film/public/reel.mp4`.
- **If the length changes,** update `RAMP_AT` in `mix.sh`. (`REEL` in `film/src/Film.tsx` now follows the 16:9 story's length, so rebuilding the vertical cut means pointing it back at `public/reel.mp4`.)
- **Don't join with one big ffmpeg filter:** that scrambled the audio, and every shot played s1's sound.

#### Generating new shots (costs money)

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

### Filming the app (`ios-demo/`)

The app shots were recorded on the simulator with two **DEBUG-only** patches. Apply them on a throwaway branch and never merge them:

- **`demo-build.patch`:** the take "Everyone is betting on everything" always builds the fixed Kalshi / DraftKings / Polymarket / Coinbase / Robinhood basket. The balance is pinned, with `-demoBalance 1250000 -demoGain 1150000` as launch args. The profile chart is a smooth demo week.
- **`render-cards.patch`:** launch with `-renderCards` to write every share-card look to the app's `Documents/cards/`.

The patches were cut against the pre-move repo, so they may need a small rebase. Recordings were made with `axe record-video`. On the simulator, `simctl io recordVideo` can fail with "Host recording is already in progress".

## Notes

- **Mock data:** all numbers, chats, X posts, comments, handles (@macromike, @dev) and returns in the film are illustrative mock-ups, not real users or results.
- **Fed photo:** the prediction-market visual uses a photo by AgnosticPreachersKid, CC BY-SA 3.0, credited on screen.
- **Logos:** company and market logos are trademarks of their owners, used to show what's tradable.
- **Fonts:** Geist (OFL).
