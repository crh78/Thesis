"""Makes the iOS app icon from the brand artwork (brand/thesis-app-store-1024.png).

The artwork is already full-bleed, 1024×1024 and square-cornered (iOS draws its
own rounded mask). This flattens any transparency, since the App Store rejects
icons with an alpha channel, and writes AppIcon.png.

    python3 docs/design/assets/make_app_icon.py   # needs Pillow; run from the repo root
"""
from pathlib import Path

from PIL import Image

here = Path(__file__).parent
out = here.parents[2] / 'apps/ios/Thesis/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png'

art = Image.open(here / 'brand/thesis-app-store-1024.png').convert('RGBA')
if art.size != (1024, 1024):
    art = art.resize((1024, 1024), Image.LANCZOS)
icon = Image.new('RGB', art.size, (7, 8, 11))  # Palette.bg
icon.paste(art, mask=art.split()[3])
icon.save(out)
print(out)
