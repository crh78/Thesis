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

PREV="$(git_app rev-parse HEAD)"
echo "• code: $APP from ${PREV:0:7} to $(git -C "$REPO_SRC" log --oneline -1 HEAD)"
git_app fetch -q "$REPO_SRC" HEAD
git_app checkout -q --detach FETCH_HEAD
[ "$(git_app rev-parse HEAD)" = "$REV" ] || { echo "$APP isn't at $REV after the fetch"; exit 1; }
# The only place the services may write (ProtectSystem=strict, ReadWritePaths in the units).
install -d -o thesis -g thesis "$APP/.data"
chown -R thesis:thesis "$APP"
sudo -u thesis -H bash -c "cd $APP && pnpm install --frozen-lockfile" >/dev/null

echo "• systemd units"
install -m 0644 "$REPO_SRC"/infra/executor/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
# The docker group is root-equivalent and only thesis-surfpool (a root unit) uses Docker. The
# restarts below drop it from the running services too.
gpasswd -d thesis docker >/dev/null 2>&1 && echo "• removed thesis from the docker group" || true

if [ "$FRESH" = 1 ]; then
  [ -f "$APP/anchor/target/deploy/thesis.so" ] || { echo "no $APP/anchor/target/deploy/thesis.so"; exit 1; }
  echo "• fresh fork (state and fake balances reset)"
  # The relay's position belongs to the old fork (it would also ignore it: another fork id).
  rm -f "$APP/.data/fork/relay-state.json"
  systemctl restart thesis-surfpool
  systemctl restart thesis-fork-up
fi

SERVICES="thesis-fork-api thesis-relay thesis-settler thesis-asset-bank thesis-marker"
RUNNING=""
for u in $SERVICES; do systemctl is-active -q "$u" && RUNNING="$RUNNING $u"; done

echo "• restarting the running services"
# try-restart leaves a unit that isn't running (say, a settler not set up yet) stopped.
systemctl try-restart $SERVICES
systemctl --no-pager --plain list-units 'thesis-*' --all | sed -n '1,/^$/p'

echo "• checking"
FAILED=""
# A unit that crashes on start flips to activating (auto-restart) within a few seconds.
sleep 10
for u in $RUNNING; do
  systemctl is-active -q "$u" || FAILED="$FAILED $u"
done
case " $RUNNING " in
  *" thesis-fork-api "*)
    ok=0
    # The fork API loads the asset bank before it listens: give it up to 90 s.
    for _ in $(seq 45); do
      curl -sf --max-time 5 http://127.0.0.1:18901/health >/dev/null && { ok=1; break; }
      sleep 2
    done
    [ "$ok" = 1 ] || FAILED="$FAILED thesis-fork-api(/health)"
    ;;
esac
if [ -n "$FAILED" ]; then
  echo "✗ not healthy after the update:$FAILED"
  for u in $FAILED; do echo "    journalctl -u ${u%%(*} -n 50 --no-pager"; done
  echo "  To go back to ${PREV:0:7}: git -C $REPO_SRC checkout --detach $PREV && sudo bash $REPO_SRC/infra/executor/update.sh"
  exit 1
fi
echo "✓ healthy:${RUNNING:- (no services were running)}$(case " $RUNNING " in *" thesis-fork-api "*) echo ", fork API /health answers";; esac)"
echo "  previous commit, for a rollback: $PREV"
