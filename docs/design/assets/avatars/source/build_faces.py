"""Builds the profile faces (apps/ios/.../avatar-person-NN) from DiceBear Notionists (CC0).

Each face is a Notionists SVG (by seed, or explicit options) with the head's
skin fill tinted to one of six tones. person-12 (dastar) starts from
dastar-base.svg; person-13 gets hand-drawn locs (LOCS_TOP). Run from a scratch
dir: python3 build_faces.py  ->  svg/ and png/ (256px, transparent).
"""
HERE = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
import json, re, subprocess, urllib.parse, urllib.request, os, sys
seeds1 = "Avery Blake Casey Drew Emery Finley Gray Harper Indie Jules Kendall Logan Marlowe Noor Oakley Parker Quinn Reese Sage Tatum Uri Vale Wren Zion".split()
seeds2 = "Ada Bea Cleo Dana Elle Faye Gia Hana Iris Jade Kira Lila Maya Nina Opal Pia Rosa Sara Tess Una Vera Willa Yara Zoe Ari Bo Cy Dax Eli Fox Gus Hal Ike Jax Kai2 Leo Max Ned Oli Pax Rex Sam Ty Vic Wes Xan Yul Zed".split()
def cand_seed(n): return seeds1[n-1] if n <= 24 else seeds2[n-25]
T = ["#F7D7C4", "#EBBF9F", "#D4A27A", "#B57A52", "#8C5636", "#74482E"]
BASE = "https://api.dicebear.com/9.x/notionists/svg?"
def fetch(params, path):
    if os.path.exists(path): return open(path).read()
    url = BASE + urllib.parse.urlencode(params)
    s = urllib.request.urlopen(url, timeout=30).read().decode()
    assert s.startswith("<svg"), url
    open(path, "w").write(s); return s
def top_groups(s):
    k = s.index('<g mask="url(#viewboxMask)">') + len('<g mask="url(#viewboxMask)">')
    body = s[k:]; out=[]; depth=0; start=None; i=0
    while i < len(body):
        if body.startswith("<g", i):
            if depth == 0: start = i
            depth += 1
        elif body.startswith("</g>", i):
            depth -= 1
            if depth == 0 and start is not None: out.append((k+start, k+i+4)); start=None
        i += 1
    return out
def tint(s, tone):
    a, b = top_groups(s)[0]               # group 0 = head (skin fill + outline)
    head = s[a:b].replace('fill="#fff"', f'fill="{tone}"', 1)
    return s[:a] + head + s[b:]
def behind_head(s, extra):
    a, _ = top_groups(s)[0]; return s[:a] + extra + s[a:]
def on_top(s, extra):
    i = s.rindex("</svg>"); return s[:i] + extra + s[i:]

LOCS_BACK = ''
LOCS_TOP = '''<g stroke="#000" stroke-linecap="round" fill="none" stroke-width="48">
<path d="M690 430 C620 520 588 660 586 900"/><path d="M742 392 C672 500 640 650 642 960"/>
<path d="M640 470 C580 560 548 700 552 860"/><path d="M1094 420 C1150 500 1168 640 1160 860"/>
<path d="M1050 384 C1110 470 1132 620 1124 780"/></g>
<path fill="#000" d="M606 600 C578 470 630 352 760 306 C880 266 1020 280 1104 350 C1164 400 1176 476 1152 560 C1120 500 1060 462 990 446 C900 428 810 440 744 480 C694 512 650 556 606 600 Z"/>
<g stroke="#fff" stroke-width="7" stroke-linecap="round" fill="none">
<path d="M690 440 C740 380 820 340 900 330"/><path d="M780 450 C840 400 920 372 1010 366"/><path d="M890 440 C950 410 1030 400 1100 410"/>
<path d="M570 640 L602 636"/><path d="M566 760 L598 758"/><path d="M620 720 L652 716"/><path d="M622 850 L654 848"/>
<path d="M1144 600 L1176 604"/><path d="M1146 730 L1178 734"/><path d="M1108 640 L1140 646"/></g>'''

def faces():
    # (look, tone index, params or candidate number, extras)
    men = [
        (2, 0), (6, 3), (8, 1), (10, 4), (14, 2), (17, 5), (19, 1), (22, 3), (32, 0), (37, 2), (61, 4),
        ("sikh", 3),
        ({"seed": "Jamal", "hair": "variant60", "beard": "variant08", "beardProbability": 100, "gestureProbability": 0, "glassesProbability": 0}, 5, "locs"),
        ({"seed": "Andre", "hair": "variant55", "beardProbability": 0, "gestureProbability": 0}, 4, None),
        ({"seed": "Mateo", "hair": "variant17", "beard": "variant05", "beardProbability": 100, "gestureProbability": 0, "glassesProbability": 0}, 2, None),
        ({"seed": "Kenji", "hair": "variant13", "beardProbability": 0, "gestureProbability": 0, "glassesProbability": 0}, 1, None),
        ({"seed": "Karim", "hair": "variant06", "beard": "variant02", "beardProbability": 100, "gestureProbability": 0, "glassesProbability": 0}, 3, None),
    ]
    women = [
        (1, 1), (3, 0), (9, 4), (12, 3), (26, 5), (39, 2), (41, 0), (46, 3), (57, 1), (58, 4), (60, 0),
        ({"seed": "Amara", "hair": "variant20", "beardProbability": 0, "gestureProbability": 0, "glassesProbability": 0}, 5, None),
        ({"seed": "Zuri", "hair": "variant59", "beardProbability": 0, "gestureProbability": 0, "glassesProbability": 0}, 4, None),
        ({"seed": "Lucia", "hair": "variant28", "beardProbability": 0, "gestureProbability": 0, "glassesProbability": 0}, 2, None),
        ({"seed": "Mei", "hair": "variant47", "beardProbability": 0, "gestureProbability": 0, "glassesProbability": 0}, 1, None),
        ({"seed": "Priya2", "hair": "variant41", "beardProbability": 0, "gestureProbability": 0, "glassesProbability": 0}, 3, None),
    ]
    out = []
    for look, lst in (("men", men), ("women", women)):
        for item in lst:
            src, tone = item[0], item[1]; extra = item[2] if len(item) > 2 else None
            out.append((look, src, tone, extra))
    return out

def render(look, src, tone, extra, idx):
    if src == "sikh":
        s = open(os.path.join(HERE, "dastar-base.svg")).read()
    elif isinstance(src, int):
        p = {"seed": cand_seed(src)}
        if src == 72: p["gestureProbability"] = 0
        s = fetch(p, f"svg/cand-{src:02d}.svg")
    else:
        s = fetch(src, f"svg/{src['seed']}.svg")
    s = tint(s, T[tone])
    if extra == "locs":
        s = on_top(s, LOCS_TOP)
    name = f"person-{idx:02d}"
    open(f"svg/{name}.svg", "w").write(s)
    subprocess.run(["rsvg-convert", "-w", "256", "-h", "256", f"svg/{name}.svg", "-o", f"png/{name}.png"], check=True)
    return name

manifest = []
for i, (look, src, tone, extra) in enumerate(faces(), start=1):
    manifest.append({"name": render(look, src, tone, extra, i), "look": look, "tone": tone,
                     "source": src if not isinstance(src, dict) else src["seed"], "extra": extra})
json.dump(manifest, open("manifest.json", "w"), indent=1)
print(len(manifest), "faces;", sum(m["look"] == "men" for m in manifest), "men")
