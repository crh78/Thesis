#!/bin/zsh
# build-film.sh: the full film = the story (ffmpeg, seconds) + the walkthrough (Remotion, cached).
#
#   ./build-film.sh                 # 1080p final → film/out/thesis-film-full.mp4
#   ./build-film.sh --preview       # 720p preview, ~2× faster Remotion → film/out/thesis-film-preview.mp4
#   ./build-film.sh --tech          # force a full re-render of the walkthrough
#   SCENE=Buy ./build-film.sh       # re-render one step (its label in CHAPTERS, src/Guide.tsx) and splice it in
#   COMP=Tech ./build-film.sh       # the older technical section instead (SCENE= then uses SECTIONS in Film.tsx)
#   ./build-film.sh --story-only    # just the story → film/out/story.mp4
#
# Story: the Seedance shots in film/public/shots, straight cuts, a light grade, grain, vignette and
# letterbox, the "Six months later." card, fade in at the top and out on the taillights.
# Walkthrough: Remotion's "Guide" composition, re-rendered only when film/src or film/public (not the
# story shots) changed since the cached render. Join: the taillights crossfade (0.4s) into the logo.
set -e
cd "${0:A:h}"
COMP=${COMP:-Guide}
OUTD=film/out; mkdir -p $OUTD
PREVIEW=0; FORCE=0; STORY_ONLY=0
for a in "$@"; do case $a in --preview) PREVIEW=1;; --tech) FORCE=1;; --story-only) STORY_ONLY=1;; esac; done
if (( PREVIEW )); then W=1280; H=720; SUF=-720; BAR=43; else W=1920; H=1080; SUF=; BAR=64; fi
FONTS=film/public/fonts
TMP=$(mktemp -d -t film)
# CRF 21 / medium: with grain baked in, CRF 18 made the story ~400MB; this keeps it ~25–30MB.
enc=(-c:v libx264 -crf 21 -preset medium -pix_fmt yuv420p -r 30 -c:a aac -ar 48000 -ac 2 -b:a 192k)
look="scale=${W}:${H}:flags=lanczos,setsar=1,eq=contrast=1.06:saturation=1.08,vignette=PI/5,noise=alls=3:allf=t,drawbox=y=0:w=iw:h=${BAR}:color=black:t=fill,drawbox=y=ih-${BAR}:w=iw:h=${BAR}:color=black:t=fill"

# ── story ────────────────────────────────────────────────────────────────────────────
t0=$(date +%s)
: > $TMP/list.txt
for s in intro s1 s2 s3 s3b s4a s4x s4b s4c CARD s5 s6 s7 s8; do
  if [ $s = CARD ]; then
    ffmpeg -v error -y -f lavfi -t 2.2 -i "color=c=black:s=${W}x${H}:r=30" -f lavfi -t 2.2 -i "anullsrc=r=48000:cl=stereo" \
      -vf "drawtext=fontfile=$FONTS/GeistSerif-Regular.ttf:text='Six months later.':x=(w-tw)/2:y=(h-th)/2:fontsize=$(( H * 7 / 100 )):fontcolor=white:alpha='if(lt(t,0.3),0,if(lt(t,0.75),(t-0.3)/0.45,if(gt(t,1.7),max(0,(2.15-t)/0.45),1)))'" \
      $enc -shortest $TMP/card.mp4
    echo "file '$TMP/card.mp4'" >> $TMP/list.txt; continue
  fi
  f=film/public/shots/$s.mp4
  D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $f)
  vf=$look; af="aresample=48000"
  [ $s = intro ] && vf="$vf,fade=t=in:d=0.6"
  [ $s = s8 ] && vf="$vf,fade=t=out:st=$(( D - 0.7 )):d=0.7" && af="$af,afade=t=out:st=$(( D - 0.7 )):d=0.7"
  if [ $s = s6 ]; then
    # the punchline cut away a second early: its last second (their faces dropping) plays at half speed,
    # with the sound playing out and fading, so the reaction lands (+1s)
    ffmpeg -v error -y -i $f -filter_complex \
      "[0:v]split[a][b];[a]trim=0:6,setpts=PTS-STARTPTS[v1];[b]trim=start=6,setpts=PTS-STARTPTS,minterpolate=fps=48:mi_mode=mci,setpts=2*PTS[v2];[v1][v2]concat=n=2:v=1:a=0,${vf}[v];[0:a]aresample=48000,apad=pad_dur=1,afade=t=out:st=$(( D - 0.2 )):d=1.2[au]" \
      -map "[v]" -map "[au]" $enc -t $(( D + 1 )) $TMP/$s.mp4
    echo "file '$TMP/$s.mp4'" >> $TMP/list.txt; continue
  fi
  if [ $s = intro ]; then   # the intro is silent
    ffmpeg -v error -y -i $f -f lavfi -i "anullsrc=r=48000:cl=stereo" -map 0:v -map 1:a -vf "$vf" $enc -shortest $TMP/$s.mp4
  else
    ffmpeg -v error -y -i $f -vf "$vf" -af "$af" $enc $TMP/$s.mp4
  fi
  echo "file '$TMP/$s.mp4'" >> $TMP/list.txt
done
ffmpeg -v error -y -f concat -safe 0 -i $TMP/list.txt -c copy $TMP/story-joined.mp4
ffmpeg -v error -y -i $TMP/story-joined.mp4 -map 0:v -map 0:a -c:v copy -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 192k $OUTD/story$SUF.mp4
SD=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $OUTD/story$SUF.mp4)
echo "story: ${SD}s in $(( $(date +%s) - t0 ))s → $OUTD/story$SUF.mp4"
if (( STORY_ONLY )); then rm -rf $TMP; exit 0; fi

# ── technical section (Remotion, cached) ─────────────────────────────────────────────
cd film
TECH=out/${COMP:l}$SUF.mp4
r=(--codec=h264 --crf=18 --concurrency=8 --gl=angle --log=error)
(( PREVIEW )) && r+=(--scale=0.6667)
t0=$(date +%s)
if [ -n "$SCENE" ] && [ -f $TECH ]; then
  # frames of that scene: SECTIONS in src/Film.tsx (Tech), or CHAPTERS in src/Guide.tsx after the logo (Guide)
  read A B <<< "$(COMP=$COMP python3 - "$SCENE" <<'PY'
import os, re, sys
if os.environ["COMP"] == "Guide":
    src = open("src/Guide.tsx").read()
    body = src[src.index("const CHAPTERS"):src.index("const STARTS")]
    secs = [(m[0] or m[2], m[1] or m[3]) for m in re.findall(r'label: "([^"]+)",[\s\S]*?dur: (\d+)|full\("([^"]+)", (\d+)', body)]
    at = int(re.search(r"const LOGO = (\d+)", src).group(1))
else:
    secs = re.findall(r'\["(\w+)", \w+, (\d+)\]', open("src/Film.tsx").read())
    at = 0
for name, dur in secs:
    if name == sys.argv[1]:
        print(at, at + int(dur) - 1); break
    at += int(dur)
else:
    sys.exit(f"no scene {sys.argv[1]}")
PY
)"
  npx remotion render src/index.ts $COMP $TMP/scene.mp4 $r --frames=$A-$B 2>&1 | grep -vE "^\s+at " | tail -2
  a=$(( A / 30.0 )); b=$(( (B + 1) / 30.0 ))
  ffmpeg -v error -y -i $TECH -i $TMP/scene.mp4 -filter_complex \
    "[0:v]trim=0:$a,setpts=PTS-STARTPTS[x];[0:v]trim=start=$b,setpts=PTS-STARTPTS[z];[x][1:v][z]concat=n=3:v=1[v]" \
    -map "[v]" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p -r 30 $TMP/tech.mp4 && mv $TMP/tech.mp4 $TECH
  echo "$COMP: re-rendered scene '$SCENE' (frames $A–$B) in $(( $(date +%s) - t0 ))s"
elif (( FORCE )) || [ ! -f $TECH ] || [ -n "$(find src public/img public/fonts public/app -newer $TECH -print -quit)" ]; then
  npx remotion render src/index.ts $COMP $TECH $r 2>&1 | grep -vE "^\s+at " | tail -2
  echo "$COMP: rendered in $(( $(date +%s) - t0 ))s → film/$TECH"
else
  echo "$COMP: cached (nothing in film/src or film/public changed) → film/$TECH"
fi
cd ..

# ── join: the taillights fade into the logo's pixel burst ───────────────────────────
OUT=$OUTD/thesis-film-full.mp4; (( PREVIEW )) && OUT=$OUTD/thesis-film-preview.mp4
TD=$(ffprobe -v error -show_entries format=duration -of csv=p=0 film/$TECH)
ffmpeg -v error -y -i $OUTD/story$SUF.mp4 -i film/$TECH -filter_complex \
  "[0:v]fps=30,settb=AVTB[s];[1:v]fps=30,scale=${W}:${H},settb=AVTB[t];[s][t]xfade=transition=fade:duration=0.4:offset=$(( SD - 0.4 ))[v];[0:a]apad=whole_dur=$(( SD + TD - 0.4 ))[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -crf 21 -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k $OUT
rm -rf $TMP
echo "film: $(ffprobe -v error -show_entries format=duration -of csv=p=0 $OUT)s → $OUT"
