#!/bin/zsh
# build-reel-16x9.sh [take=1]: cut the landscape reel from out-16x9/480p.
#
#   ./build-reel-16x9.sh                  # take 1 of every shot
#   PICK="s3=2 s6=2" ./build-reel-16x9.sh # take 1, except s3 and s6 from take 2
#   INTRO=out-16x9/intro/intro-dish-machine-titled.mp4 ./build-reel-16x9.sh
#
# Order: muted titled intro → s1 … s4a → s4x (phone blows up) → s4b, s4c → "Six months later." → s5 … s8.
# Writes out-16x9/reel-16x9.mp4. Segments are re-encoded to one format, then joined with the
# concat demuxer (one big ffmpeg filter scrambled the audio before).
set -e
cd "${0:A:h}"
TAKE=${1:-1}
INTRO=${INTRO:-out-16x9/intro/intro-dish-machine-titled.mp4}
typeset -A pick; for kv in ${=PICK:-}; do pick[${kv%%=*}]=${kv#*=}; done
SEG=$(mktemp -d -t reel16)
enc=(-c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p -r 24 -c:a aac -ar 44100 -ac 2 -b:a 160k)
SIZE=854x480

ffmpeg -v error -y -i $INTRO -f lavfi -i "anullsrc=r=44100:cl=stereo" -map 0:v -map 1:a \
  -vf "scale=${SIZE/x/:},setsar=1" $enc -shortest $SEG/intro.mp4
# "Six months later.": Geist Serif on black, fading in and out over 2s.
FONTS=../film/public/fonts
ffmpeg -v error -y -f lavfi -t 2 -i "color=c=black:s=${SIZE}:r=24" -f lavfi -t 2 -i "anullsrc=r=44100:cl=stereo" \
  -vf "drawtext=fontfile=$FONTS/GeistSerif-Regular.ttf:text='Six months later.':x=(w-tw)/2:y=(h-th)/2:fontsize=38:fontcolor=white:alpha='if(lt(t,0.35),t/0.35,if(gt(t,1.6),max(0,(2-t)/0.4),1))',setsar=1" \
  $enc -shortest $SEG/card.mp4

# The group chat going off (Remotion: film/ GroupChatInsert), with a ping per notification.
CHAT=${CHAT:-}   # e.g. ../film/out/groupchat-insert.mp4; off by default (Seedance shot s4x instead)
if [ -n "$CHAT" ] && [ -f $CHAT ]; then
  D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $CHAT)
  ffmpeg -v error -y -f lavfi -i "aevalsrc='0.35*sin(2*PI*1318*t)*exp(-14*t)+0.25*sin(2*PI*1976*t)*exp(-18*t)':s=44100:d=0.5" $SEG/ping.wav
  pings=(); mix=""; i=1
  for at in 1.47 3.07 4.13 5.0; do pings+=(-i $SEG/ping.wav); ms=$(printf %.0f $(( at * 1000 ))); mix+="[${i}:a]adelay=${ms}|${ms}[p${i}];"; i=$((i+1)); done
  ffmpeg -v error -y -i $CHAT $pings -f lavfi -t $D -i "anullsrc=r=44100:cl=stereo" -filter_complex \
    "${mix}[5:a][p1][p2][p3][p4]amix=inputs=5:normalize=0:duration=first[a]" \
    -map 0:v -map "[a]" -vf "scale=${SIZE/x/:},setsar=1" $enc $SEG/chat.mp4
fi

echo "file '$SEG/intro.mp4'" > $SEG/list.txt
for s in s1-dumped s2-the-pattern s3-who-wins s3b-own-the-house s4a-jump-1-20k CHAT s4x-phone-blows-up s4b-jump-2-100k s4c-jump-3-1-25m CARD s5-shes-back s6-punchline s7-first-million s8-drive-off; do
  if [ $s = CARD ]; then echo "file '$SEG/card.mp4'" >> $SEG/list.txt; continue; fi
  if [ $s = CHAT ]; then [ -f $SEG/chat.mp4 ] && echo "file '$SEG/chat.mp4'" >> $SEG/list.txt && echo "  group chat insert"; continue; fi
  t=${pick[${s%%-*}]:-$TAKE}
  f=out-16x9/480p/$s-take$t.mp4
  if [ ! -f $f ]; then echo "  missing $f, skipped"; continue; fi
  ffmpeg -v error -y -i $f -vf "scale=${SIZE/x/:},setsar=1" -af "aresample=44100" $enc $SEG/$s.mp4
  echo "file '$SEG/$s.mp4'" >> $SEG/list.txt
  echo "  $s: take $t"
done
ffmpeg -v error -y -f concat -safe 0 -i $SEG/list.txt -c copy out-16x9/reel-16x9.mp4
rm -rf $SEG
echo "out-16x9/reel-16x9.mp4: $(ffprobe -v error -show_entries format=duration -of csv=p=0 out-16x9/reel-16x9.mp4)s"
