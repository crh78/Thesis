# Thesis logo: Pixel reactions

A pixel speech bubble (your take), split green for Trade and pink for Fade, with two
people reacting to it: green ring traded it, pink ring faded it. The bubble is on the
same square grid as the Geist Pixel wordmark; the faces are the app's own avatars.

## Which file to upload where

| File | Use it for |
|---|---|
| `thesis-app-store-1024.png` | App Store Connect app icon. 1024×1024, square corners, no transparency (Apple rounds the corners). |
| `thesis-x-avatar-400.png` | X / Twitter profile picture. Sized for X's circle crop. |
| `thesis-x-avatar-1000.png` | Same, higher resolution (Instagram, LinkedIn, Discord, etc.). |
| `thesis-mark-dark.svg` | The mark alone, for dark backgrounds (decks, the website). |
| `thesis-mark-light.svg` | The mark alone, for light backgrounds. |
| `thesis-app-store-1024.svg`, `thesis-x-avatar.svg` | Editable sources of the two PNGs. |

The App Store and X only take PNG or JPG, not SVG.

The iOS app icon (`AppIcon.png`) is built from `thesis-app-store-1024.png`:
`python3 docs/design/assets/make_app_icon.py` from the repo root. Run it again after
changing the artwork, so the store listing and the home screen match.

Colors (from `Palette.swift`): Trade `#A9E3BA`, Fade `#F3B6CC`, Aurora `#8296FF`,
background `#07080B`. On light backgrounds: Trade `#1E7A43`, Fade `#B23A68`.
