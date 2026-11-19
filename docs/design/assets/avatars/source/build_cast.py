"""Builds the demo cast's faces (Johnny, Nina, Priya, Danny) from DiceBear Notionists (CC0), the
same set as the profile faces (build_faces.py), with small hand edits:

  Johnny  brown hair, stubble (Notionists beard 02's shape, dotted, clipped to the face)
  Nina    long blond hair and a baseball cap
  Priya   green flannel overshirt
  Danny   a middle part

Dev keeps his existing face. Run from a scratch dir: python3 build_cast.py -> cast/<name>.svg, and
cast/<name>.png (128 px, background baked in, like the other demo faces) when rsvg-convert is
installed. The committed SVGs are in source/cast/.
"""
import os, re, shutil, subprocess, urllib.parse, urllib.request

BASE = "https://api.dicebear.com/9.x/notionists/svg?"
COMMON = {"glassesProbability": 0, "gestureProbability": 0, "beardProbability": 0}
TONES = ["#F7D7C4", "#EBBF9F", "#D4A27A", "#B57A52", "#8C5636", "#74482E"]
OPEN = '<g mask="url(#viewboxMask)">'

def fetch(params, path):
    if os.path.exists(path): return open(path).read()
    s = urllib.request.urlopen(BASE + urllib.parse.urlencode(params), timeout=30).read().decode()
    assert s.startswith("<svg"), params
    open(path, "w").write(s); return s

def groups(s):
    """The top-level groups: 0 head, 1 body, 2 hair, 3 lips, 4 beard, 5 nose, 6 eyes, 7 glasses, 8 brows."""
    k = s.index(OPEN) + len(OPEN); body = s[k:]; out = []; depth = 0; start = None; i = 0
    while i < len(body):
        if body.startswith("<g", i):
            if depth == 0: start = i
            depth += 1
        elif body.startswith("</g>", i):
            depth -= 1
            if depth == 0: out.append((k + start, k + i + 4))
        i += 1
    return out

def edit(s, idx, fn): a, b = groups(s)[idx]; return s[:a] + fn(s[a:b]) + s[b:]
def group(s, idx): a, b = groups(s)[idx]; return s[a:b]
def skin(s, tone): return edit(s, 0, lambda g: g.replace('fill="#fff"', f'fill="{tone}"', 1))
def hair(s, color): return edit(s, 2, lambda g: g.replace('fill="#000"', f'fill="{color}"'))
def defs(s, d): i = s.index(OPEN); return s[:i] + "<defs>" + d + "</defs>" + s[i:]
def background(s, color): i = s.index(OPEN) + len(OPEN); return s[:i] + f'<rect width="1744" height="1744" fill="{color}"/>' + s[i:]
def on_top(s, extra): i = s.rindex("</g></svg>"); return s[:i] + extra + s[i:]

STUBBLE = ('<pattern id="stub" width="22" height="22" patternUnits="userSpaceOnUse">'
           '<circle cx="5" cy="6" r="3.2" fill="#000" fill-opacity=".55"/><circle cx="16" cy="15" r="3.2" fill="#000" fill-opacity=".55"/>'
           '<circle cx="15" cy="3" r="2.4" fill="#000" fill-opacity=".4"/></pattern>')
FLANNEL = ('<pattern id="plaid" width="120" height="120" patternUnits="userSpaceOnUse"><rect width="120" height="120" fill="#4E9A62"/>'
           '<rect width="120" height="40" fill="#000" fill-opacity=".38"/><rect width="40" height="120" fill="#000" fill-opacity=".38"/>'
           '<rect x="78" width="7" height="120" fill="#000"/><rect y="78" width="120" height="7" fill="#000"/></pattern>')
CAP = ('<g stroke="#000" stroke-width="18" stroke-linejoin="round">'
       '<path d="M1060 575 C1180 560 1290 575 1335 615 C1270 640 1160 640 1060 628 Z" fill="#000"/>'
       '<path d="M545 625 C530 420 690 300 860 296 C1030 292 1150 400 1150 600 C960 560 740 570 545 625 Z" fill="#fff"/></g>'
       '<path d="M860 300 C840 420 850 520 880 575" stroke="#000" stroke-width="12" fill="none"/><circle cx="858" cy="300" r="22" fill="#000"/>')
PART = '<path d="M902 372 C893 450 905 545 940 630" stroke="#EBBF9F" stroke-width="17" fill="none" stroke-linecap="round"/>'

def head_clip(s):
    """The head's outline as a clip path (each path carries the head group's transform)."""
    g = group(s, 0); tr = re.search(r'transform="([^"]+)"', g).group(1)
    paths = "".join(re.sub(r'fill="[^"]*"', "", p).replace("<path ", f'<path transform="{tr}" ', 1) for p in re.findall(r"<path[^>]*/>", g))
    return f'<clipPath id="headclip">{paths}</clipPath>'

def johnny():
    p = {**COMMON, "seed": "Johnny", "hair": "variant13", "body": "variant05", "lips": "variant14"}
    s = fetch(p, "svg/johnny.svg")
    beard = fetch({**p, "beard": "variant02", "beardProbability": 100}, "svg/johnny-beard.svg")
    s = hair(skin(s, TONES[0]), "#6B4423")
    stub = group(beard, 4).replace('fill="#000"', 'fill="url(#stub)"')
    s = edit(s, 4, lambda _: f'<g clip-path="url(#headclip)">{stub}</g>')
    return background(defs(s, STUBBLE + head_clip(s)), "#B6E3F4")

def nina():
    s = fetch({**COMMON, "seed": "Nina", "hair": "variant41", "body": "variant23", "lips": "variant25"}, "svg/nina.svg")
    return background(on_top(hair(skin(s, TONES[0]), "#E8C468"), CAP), "#FFD5DC")

def priya():
    s = fetch({**COMMON, "seed": "Priya", "hair": "variant23", "body": "variant05", "lips": "variant03"}, "svg/priya.svg")
    s = edit(skin(s, TONES[2]), 1, lambda g: g.replace('fill="#fff"', 'fill="url(#plaid)"', 1))
    return background(defs(s, FLANNEL), "#FFDFBF")

def danny():
    s = fetch({**COMMON, "seed": "Danny", "hair": "variant25", "body": "variant14", "lips": "variant22"}, "svg/danny.svg")
    return background(on_top(skin(s, TONES[1]), PART), "#C8ECD4")

if __name__ == "__main__":
    os.makedirs("svg", exist_ok=True); os.makedirs("cast", exist_ok=True)
    for name, build in (("johnny", johnny), ("nina", nina), ("priya", priya), ("danny", danny)):
        open(f"cast/{name}.svg", "w").write(build())
        if shutil.which("rsvg-convert"):
            subprocess.run(["rsvg-convert", "-w", "128", "-h", "128", f"cast/{name}.svg", "-o", f"cast/{name}.png"], check=True)
        print("wrote", name)
