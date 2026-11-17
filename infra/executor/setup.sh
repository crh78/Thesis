#!/usr/bin/env bash
# Sets up a fresh Oracle Cloud Always Free Ampere A1 VM (Ubuntu 24.04, aarch64) to run the
# Thesis executor: the fork, the fork API, the Stream relay, the settler and the asset-bank
# poller. Run it as root on the VM, from a checkout of this repo:
#
#   sudo bash infra/executor/setup.sh
#
# It installs packages and the systemd units and creates the `thesis` user. It doesn't start
# anything, join Tailscale or write secrets: infra/executor/README.md has those steps. Safe to
# rerun.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
[ "$(uname -m)" = aarch64 ] || echo "note: this is $(uname -m), not aarch64; the units work anyway"

REPO_SRC="$(cd "$(dirname "$0")/../.." && pwd)"
APP=/opt/thesis
PNPM_VERSION="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$REPO_SRC/package.json")"

echo "• packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git jq docker.io >/dev/null
systemctl enable --now docker >/dev/null

echo "• Node 24"
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable

echo "• Tailscale"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

echo "• user thesis"
id thesis >/dev/null 2>&1 || useradd --create-home --shell /bin/bash thesis
usermod -aG docker thesis

echo "• app in $APP"
if [ "$REPO_SRC" != "$APP" ]; then
  mkdir -p "$APP"
  # The checkout this script came from; later updates: git pull in $APP.
  [ -d "$APP/.git" ] || git clone -q "$REPO_SRC" "$APP"
fi
chown -R thesis:thesis "$APP"
sudo -u thesis -H bash -c "cd $APP && corepack prepare pnpm@$PNPM_VERSION --activate >/dev/null && pnpm install --frozen-lockfile"

echo "• secrets directory (root only)"
install -d -m 0700 -o root -g root /etc/thesis
[ -f /etc/thesis/executor.env ] || install -m 0600 -o root -g root "$REPO_SRC/infra/executor/executor.env.example" /etc/thesis/executor.env

echo "• Surfpool image (linux/arm64)"
docker pull -q surfpool/surfpool:1.7.0 >/dev/null

echo "• systemd units"
install -m 0644 "$REPO_SRC"/infra/executor/systemd/*.service /etc/systemd/system/
# The OCI Vault drop-in isn't installed here: it's for mainnet (README, "Settler key in OCI Vault").
systemctl daemon-reload

cat <<NEXT

Done. Next (infra/executor/README.md):
  1. tailscale up --ssh --hostname=thesis-executor
  2. edit /etc/thesis/executor.env  the keys (root only)
  3. copy thesis.so to $APP/anchor/target/deploy/, and seed $APP/.data/asset-bank.json
  4. systemctl enable --now thesis-surfpool thesis-fork-up thesis-asset-bank thesis-fork-api thesis-relay
  5. install -m 0600 $APP/.data/fork/settler.json /etc/thesis/settler.json && systemctl enable --now thesis-settler
  6. tailscale funnel --bg --https=443 http://127.0.0.1:18901
     tailscale funnel --bg --https=8443 http://127.0.0.1:18902
NEXT
