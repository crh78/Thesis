# "I own the place": Thesis brainrot reel

Vertical 9:16, stylized 3D animation. Part 1 is the Seedance story, about 60s. Part 2 is the Remotion technical section (`../film`).
Music goes on in the edit (`../film/mix.sh`). The final cut uses take 2 of every shot, with the muted blender intro (i1) titled by `title.sh`.

## Part 1: the story (Seedance)

| # | Shot | Length | What happens | Dialogue | Caption (edit) |
|---|---|---|---|---|---|
| s1 | Dumped | 7s | His girlfriend dumps him at the host stand, drops his necklace on his tray and walks out. | HER: "We're done. I'm not dating a guy who makes twelve dollars an hour." | she left him bc he was broke 💔 |
| s2 | The pattern | 8s | Three booths, everyone betting on their phones. | "Two hundred on the Knicks!" / "I just bet it rains tomorrow." / GRANDMA: "I've got money on the Oscars." | then he noticed something… |
| s3 | Realization | 5s | Kitchen, phone glow, eyes wide. | "Wait… everyone's betting on everything." | |
| s4a | Bet 1 | 7s | He opens Thesis, the bet page flashes, he taps. The money page flashes **$20K**. "+$20K" pops into the air. | "Let's ride." | |
| s4b | Bet 2 | 6s | 3am, his tiny apartment, he doubles down. The money page flashes **$100K**. "+$100K" bursts and he falls back on the bed laughing. | | |
| s4c | Bet 3 | 7s | Behind the diner counter, all in. The money page flashes **$1.25M**. "+$1.25M" explodes and money rains on the whole diner. | COWORKER: "BROOO!" | |
| — | | 1s | Black | | **6 months later** |
| s5 | She's back | 7s | She walks in with her jacked new boyfriend. | BF: "Babe, is that your ex? Bro's still flipping burgers." / HER: "Told you he'd be broke forever." | |
| s6 | Punchline | 6s | He sets the plates down. | "Nah. I own the place." / MANAGER: "Morning, boss." | |
| s7 | Bugatti | 7s | He tosses the key, walks out to an unbadged Bugatti-shaped hypercar and roars off. They're pressed against the window. | | |

## Part 2: what Thesis does

Built in Remotion instead (`../film`): the reel fades to black, the pixel logo assembles, then the technical section. See `../README.md`.

## References (`refs/`)

`him.jpg` (supplied), `her.png`, `newguy.png`, `place.png` (Seedream). The app screens are from the demo build: `app-bet.png` and `app-money-1/2/3.png` ($20K / $100K / $1.25M).

The demo build (`../ios-demo/demo-build.patch`, never merge) hardcodes the basket and the balance. Launch it with `-demoBalance N -demoGain N`.

## Making it

```
python3 gen.py shots --res 480p --takes 2    # drafts, about $12.30
python3 gen.py shots --res 720p --only s1,s6 # finals for the keepers
```
