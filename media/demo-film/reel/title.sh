#!/bin/zsh
# title.sh <in.mp4> <out.mp4> [start=0.3] [end=4.8]
# Puts "thesis / social trading for ideas" over an intro clip, then "a short film", fading in and out,
# like the laundromat film's opening. The title holds for the first ~55% of [start, end].
set -e
IN=$1; OUT=$2; A=${3:-0.3}; B=${4:-4.8}
FONTS="${0:A:h}/../film/public/fonts"
[ -d "$FONTS" ] || FONTS="${0:A:h}/film/public/fonts"
H=$(ffprobe -v error -select_streams v -show_entries stream=height -of csv=p=0 $IN)
FILTER=$(mktemp -t title).txt
python3 - "$FONTS" "$H" "$A" "$B" > $FILTER <<'PY'
import sys
fonts, h, a, b = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
big, small = h * 21 // 100, h * 42 // 1000
m = a + (b - a) * 0.55  # the title holds until here, then "a short film" takes over

def fade(t0, t1, d=0.5):
    return (f"if(lt(t\\,{t0})\\,0\\,if(lt(t\\,{t0 + d})\\,(t-{t0})/{d}\\,"
            f"if(lt(t\\,{t1 - d})\\,1\\,if(lt(t\\,{t1})\\,({t1}-t)/{d}\\,0))))")

title, film = fade(a, m), fade(m + 0.15, b)
print(f"[0:v]drawtext=fontfile={fonts}/GeistPixel-Square.ttf:text=thesis:fontsize={big}:fontcolor=white:"
      f"alpha={title}:x=(w-tw)/2:y=(h-th)/2-{h * 2 // 100}:shadowcolor=black@0.45:shadowx=0:shadowy=3,"
      f"drawtext=fontfile={fonts}/GeistMono-Regular.ttf:text=social trading for ideas:fontsize={small}:fontcolor=white@0.9:"
      f"alpha={title}:x=(w-tw)/2:y=(h/2)+{big * 55 // 100}:shadowcolor=black@0.5:shadowx=0:shadowy=2,"
      f"drawtext=fontfile={fonts}/GeistMono-Regular.ttf:text=a short film:fontsize={small * 16 // 10}:fontcolor=white:"
      f"alpha={film}:x=(w-tw)/2:y=(h-th)/2:shadowcolor=black@0.55:shadowx=0:shadowy=3[v]")
PY
ffmpeg -v error -y -i $IN -filter_complex_script $FILTER -map "[v]" -map "0:a?" \
  -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -c:a copy $OUT
rm -f $FILTER
echo $OUT
