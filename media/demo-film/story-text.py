#!/usr/bin/env python3
"""Text for the story, drawn with Pillow (Homebrew's ffmpeg has no drawtext or libass).

  story-text.py card <out.png> <W> <H>          the "Six months later." card, transparent PNG
  story-text.py captions <in.mp4> <out.mp4>     burns captions.json into the story (re-encodes the video, copies the audio)

captions.json: [start, end, text] in seconds into the story; "\\n" splits a caption into two lines.
Needs python3 with Pillow (pip install pillow) and ffmpeg.
"""
import json, os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = f"{HERE}/film/public/fonts"


def card(out, W, H):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fnt = ImageFont.truetype(f"{FONTS}/GeistSerif-Regular.ttf", H * 7 // 100)
    ImageDraw.Draw(img).text((W / 2, H / 2), "Six months later.", font=fnt, fill="white", anchor="mm")
    img.save(out)


def captions(src, out):
    W, H = (int(v) for v in subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", src]).decode().split(","))
    k = H / 1080
    fnt = ImageFont.truetype(f"{FONTS}/Geist-Medium.ttf", round(42 * k))
    cues = json.load(open(f"{HERE}/captions.json"))
    tmp = tempfile.mkdtemp(prefix="captions")
    args, chain, last = ["ffmpeg", "-v", "error", "-y", "-i", src], [], "0:v"
    for i, (a, b, text) in enumerate(cues):
        fg = Image.new("RGBA", (W, H), (0, 0, 0, 0)); sh = fg.copy()
        lines = text.split("\n")
        for j, ln in enumerate(lines):
            y = 990 * k - (len(lines) - 1 - j) * 54 * k       # just above the bottom letterbox bar
            ImageDraw.Draw(sh).text((W / 2, y + 2 * k), ln, font=fnt, fill=(0, 0, 0, 235), anchor="md", stroke_width=round(5 * k), stroke_fill=(0, 0, 0, 235))
            ImageDraw.Draw(fg).text((W / 2, y), ln, font=fnt, fill="white", anchor="md")
        Image.alpha_composite(sh.filter(ImageFilter.GaussianBlur(7 * k)), fg).save(f"{tmp}/{i:02d}.png")
        args += ["-loop", "1", "-framerate", "30", "-t", f"{b + 0.2:.2f}", "-i", f"{tmp}/{i:02d}.png"]
        chain.append(f"[{i + 1}:v]format=rgba,fade=t=in:st={a:.2f}:d=0.12:alpha=1,fade=t=out:st={b - 0.15:.2f}:d=0.15:alpha=1[c{i}];"
                     f"[{last}][c{i}]overlay=enable='between(t,{a:.2f},{b:.2f})':eof_action=pass[v{i}]")
        last = f"v{i}"
    args += ["-filter_complex", ";".join(chain), "-map", f"[{last}]", "-map", "0:a", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", out]
    subprocess.run(args, check=True)


if __name__ == "__main__":
    if sys.argv[1] == "card":
        card(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    elif sys.argv[1] == "captions":
        captions(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
