#!/bin/zsh
# composite-s4x.sh: render the PhoneUI lock screen (film/src/Screens.tsx) and composite it onto the blank
# phone in film/public/shots/s4x-raw.mp4 → s4x-composite.mp4, then use it as s4x.mp4 in the story.
# Needs: python3 with numpy + opencv-python-headless (pip install numpy opencv-python-headless), ffmpeg.
set -e
cd "${0:A:h}"
TMP=$(mktemp -d -t phoneui); UI=$TMP/frames   # Remotion wants a directory that does not exist yet
(cd film && npx remotion render src/index.ts PhoneUI $UI --sequence --image-format=png --concurrency=4 --log=error)
python3 composite-s4x.py $UI
cp film/public/shots/s4x-composite.mp4 film/public/shots/s4x.mp4
rm -rf $TMP
echo "film/public/shots/s4x.mp4 updated; ./build-film.sh to rebuild the story"
