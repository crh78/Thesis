#!/bin/zsh
# mix.sh [in=out/film-nomusic.mp4] [out=out/thesis-film-final.mp4] [music=../reel/music/2-lofi.wav]
#
# Lays the music bed under a Remotion render and normalizes loudness:
#  - the ~33s clip is looped 4× with 1.5s crossfades and trimmed to the film,
#  - 13% under the reel (so the dialogue reads), ramping to 70% from RAMP_AT to RAMP_AT+2.5s
#    (the reel fades to black at ~68s), fade in 1.5s, fade out over the last 3.5s,
#  - then loudnorm to -16 LUFS / -1.5 dBTP (the raw mix measured about -27 LUFS).
set -e
cd "${0:A:h}"
IN=${1:-out/film-nomusic.mp4}; OUT=${2:-out/thesis-film-final.mp4}; M=${3:-../reel/music/2-lofi.wav}
LOW=${LOW:-0.13}; HIGH=${HIGH:-0.70}; RAMP_AT=${RAMP_AT:-67}
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $IN)
TMP=$(mktemp -d -t mix)
ffmpeg -v error -y -i $M -i $M -i $M -i $M -filter_complex \
  "[0][1]acrossfade=d=1.5[a];[a][2]acrossfade=d=1.5[b];[b][3]acrossfade=d=1.5,atrim=0:$D,asetpts=PTS-STARTPTS[m]" \
  -map "[m]" -ar 48000 -ac 2 $TMP/bed.wav
R2=$(( RAMP_AT + 2.5 )); FO=$(( D - 3.5 ))
ffmpeg -v error -y -i $IN -i $TMP/bed.wav -filter_complex "\
[1:a]volume='if(lt(t,$RAMP_AT),$LOW,if(lt(t,$R2),$LOW+(t-$RAMP_AT)/2.5*($HIGH-$LOW),$HIGH))':eval=frame,afade=t=in:d=1.5,afade=t=out:st=$FO:d=3.5[m];\
[0:a]aresample=48000[v];[v][m]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k $TMP/mixed.mp4
ffmpeg -v error -y -i $TMP/mixed.mp4 -map 0:v -map 0:a -c:v copy -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 192k $OUT
rm -rf $TMP
echo "$OUT (${D}s)"
