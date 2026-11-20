#!/bin/zsh
# build-reel.sh [take=2]: cut the vertical reel from the Seedance shots in out/480p.
#
#   ./build-reel.sh            # take 2 of every shot (the cut in the film)
#   ./build-reel.sh 1          # take 1 of every shot
#   PICK="s1=1 s6=1" ./build-reel.sh   # take 2, except s1 and s6 from take 1
#
# Order: muted blender intro with the title → s1 … s4c → "6 months later" card → s5 … s7.
# Writes out/reel-take<N>-480p.mp4 (story only), out/reel-take<N>-intro-480p.mp4 (with the
# intro), and copies the latter to ../film/public/reel.mp4 for Remotion.
#
# Every segment is re-encoded to the same format, then joined with the concat demuxer.
# (Joining in one big ffmpeg filter scrambled the audio: every shot played s1's sound.)
set -e
cd "${0:A:h}"
TAKE=${1:-2}
typeset -A pick; for kv in ${=PICK:-}; do pick[${kv%%=*}]=${kv#*=}; done
SEG=$(mktemp -d -t reel)
enc=(-c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p -r 24 -c:a aac -ar 44100 -ac 2 -b:a 160k)
FONT=/System/Library/Fonts/Supplemental/Arial\ Bold.ttf; [ -f "$FONT" ] || FONT=/System/Library/Fonts/Helvetica.ttc

# Title over the intro (out/intro/intro-blender-titled.mp4), then drop its audio.
[ -f out/intro/intro-blender-titled.mp4 ] || ./title.sh out/480p/i1-intro-blender-take1.mp4 out/intro/intro-blender-titled.mp4
ffmpeg -v error -y -i out/intro/intro-blender-titled.mp4 -f lavfi -i "anullsrc=r=44100:cl=stereo" -map 0:v -map 1:a \
  -vf "scale=480:854,setsar=1" $enc -shortest $SEG/intro.mp4

ffmpeg -v error -y -f lavfi -t 1.5 -i "color=c=black:s=480x854:r=24" -f lavfi -t 1.5 -i "anullsrc=r=44100:cl=stereo" \
  -vf "drawtext=fontfile='$FONT':text='6 months later':x=(w-tw)/2:y=(h-th)/2:fontsize=40:fontcolor=white,setsar=1" \
  $enc -shortest $SEG/card.mp4

: > $SEG/list.txt
for s in s1-dumped s2-the-pattern s3-realization s4a-bet-1-20k s4b-bet-2-100k s4c-bet-3-1-25m CARD s5-shes-back s6-punchline s7-bugatti; do
  if [ $s = CARD ]; then echo "file '$SEG/card.mp4'" >> $SEG/list.txt; continue; fi
  t=${pick[${s%%-*}]:-$TAKE}
  ffmpeg -v error -y -i out/480p/$s-take$t.mp4 -vf "scale=480:854,setsar=1" -af "aresample=44100" $enc $SEG/$s.mp4
  echo "file '$SEG/$s.mp4'" >> $SEG/list.txt
  echo "  $s: take $t"
done
ffmpeg -v error -y -f concat -safe 0 -i $SEG/list.txt -c copy out/reel-take$TAKE-480p.mp4
{ echo "file '$SEG/intro.mp4'"; cat $SEG/list.txt; } > $SEG/list-intro.txt
ffmpeg -v error -y -f concat -safe 0 -i $SEG/list-intro.txt -c copy out/reel-take$TAKE-intro-480p.mp4
cp out/reel-take$TAKE-intro-480p.mp4 ../film/public/reel.mp4
rm -rf $SEG
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 out/reel-take$TAKE-intro-480p.mp4)
echo "out/reel-take$TAKE-intro-480p.mp4: ${D}s → ../film/public/reel.mp4"
echo "If the length changed, set REEL in ../film/src/Film.tsx to round(${D} × 30) frames, and the music ramp in ../film/mix.sh."
