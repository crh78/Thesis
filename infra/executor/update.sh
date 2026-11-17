#!/usr/bin/env bash
# Moves /opt/thesis to the commit checked out where this script lives (normally ~/thesis, the
# VM's GitHub clone), reinstalls the systemd units and restarts the running services. Run it as
# root after updating that clone:
#
#   git -C ~/thesis fetch origin && git -C ~/thesis checkout --detach origin/main
#   sudo bash ~/thesis/infra/executor/update.sh               # restart the fork API, relay, settler, poller
#   sudo bash ~/thesis/infra/executor/update.sh --fresh-fork  # also restart the fork: a new program build
#
# --fresh-fork restarts Surfpool and fork:up, which resets the fork's state and fake balances.
# Copy the new thesis.so to /opt/thesis/anchor/target/deploy/ first.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }

REPO_SRC="$(cd "$(dirname "$0")/../.." && pwd)"
APP=/opt/thesis
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh-fork) FRESH=1 ;;
    *) echo "unknown option: $arg"; exit 1 ;;
  esac
done
[ "$REPO_SRC" != "$APP" ] || { echo "run this from the source clone (~/thesis), not $APP"; exit 1; }

REV="$(git -C "$REPO_SRC" rev-parse HEAD)"
git_app() { git -c safe.directory="$APP" -C "$APP" "$@"; }

echo "• code: $APP to $(git -C "$REPO_SRC" log --oneline -1 HEAD)"
git_app fetch -q "$REPO_SRC" HEAD
git_app checkout -q --detach FETCH_HEAD
[ "$(git_app rev-parse HEAD)" = "$REV" ] || { echo "$APP isn't at $REV after the fetch"; exit 1; }
chown -R thesis:thesis "$APP"
sudo -u thesis -H bash -c "cd $APP && pnpm install --frozen-lockfile" >/dev/null

echo "• systemd units"
install -m 0644 "$REPO_SRC"/infra/executor/systemd/*.service /etc/systemd/system/
systemctl daemon-reload

if [ "$FRESH" = 1 ]; then
  [ -f "$APP/anchor/target/deploy/thesis.so" ] || { echo "no $APP/anchor/target/deploy/thesis.so"; exit 1; }
  echo "• fresh fork (state and fake balances reset)"
  systemctl restart thesis-surfpool
  systemctl restart thesis-fork-up
fi

echo "• restarting the running services"
# try-restart leaves a unit that isn't running (say, a settler not set up yet) stopped.
systemctl try-restart thesis-fork-api thesis-relay thesis-settler thesis-asset-bank thesis-marker
systemctl --no-pager --plain list-units 'thesis-*' --all | sed -n '1,/^$/p'
