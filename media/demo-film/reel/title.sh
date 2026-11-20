#!/bin/zsh
# title.sh <in.mp4> <out.mp4> [start=0.6] [end=4.8]
# Puts "thesis / social trading for ideas" over an intro clip, fading in and out, like the laundromat film's opening.
set -e
IN=$1; OUT=$2; A=${3:-0.6}; B=${4:-4.8}
FONTS="${0:A:h}/../film/public/fonts"
H=$(ffprobe -v error -select_streams v -show_entries stream=height -of csv=p=0 $IN)
FILTER=$(mktemp -t title).txt
python3 - "$FONTS" "$H" "$A" "$B" > $FILTER <<'EOF'
import sys
fonts, h, a, b = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
big, small = h * 13 // 100, h * 26 // 1000
alpha = f"if(lt(t\\,{a})\\,0\\,if(lt(t\\,{a+0.6})\\,(t-{a})/0.6\\,if(lt(t\\,{b-0.6})\\,1\\,if(lt(t\\,{b})\\,({b}-t)/0.6\\,0))))"
print(f"[0:v]drawtext=fontfile={fonts}/GeistPixel-Square.ttf:text=thesis:fontsize={big}:fontcolor=white:"
      f"alpha={alpha}:x=(w-tw)/2:y=(h-th)/2-{h*2//100}:shadowcolor=black@0.45:shadowx=0:shadowy=3,"
      f"drawtext=fontfile={fonts}/GeistMono-Regular.ttf:text=social trading for ideas:fontsize={small}:fontcolor=white@0.9:"
      f"alpha={alpha}:x=(w-tw)/2:y=(h/2)+{big*55//100}:shadowcolor=black@0.5:shadowx=0:shadowy=2[v]")
EOF
ffmpeg -v error -y -i $IN -filter_complex_script $FILTER -map "[v]" -map "0:a?" \
  -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -c:a copy $OUT
rm -f $FILTER
echo $OUT
