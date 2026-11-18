#!/usr/bin/env bash
# Publishes the fork API through Caddy on this VM (infra/executor/caddy/Caddyfile). Run as root:
#
#   sudo bash infra/executor/caddy/setup.sh <host>      e.g. api.example.com
#
# Before it works from outside: a DNS A record for <host> pointing at this VM's public IP, and an
# ingress rule for TCP 443 in the VM's OCI security list (README, "Publish with Caddy"). Caddy
# keeps trying for a certificate until both are in place. Safe to rerun; without <host> it keeps
# the one in /etc/thesis/caddy.env.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV=/etc/thesis/caddy.env

HOST="${1:-$(sed -n 's/^FORK_API_HOST=//p' "$ENV" 2>/dev/null)}"
[ -n "$HOST" ] || { echo "no host: run with the fork API's host name, e.g. api.example.com"; exit 1; }
# The VM's own address (the one its default route uses): Caddy listens there only, since
# Tailscale holds 443 on its interface while Funnel is on.
BIND="$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
[ -n "$BIND" ] || { echo "couldn't find this VM's address"; exit 1; }
install -d -m 0700 -o root -g root /etc/thesis
printf 'FORK_API_HOST=%s\nFORK_API_BIND=%s\n' "$HOST" "$BIND" > "$ENV"
chmod 0644 "$ENV"

echo "• caddy (Ubuntu package)"
command -v caddy >/dev/null || { apt-get update -qq; apt-get install -y -qq caddy >/dev/null; }

echo "• Caddyfile and settings"
install -m 0644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s\n' "$ENV" > /etc/systemd/system/caddy.service.d/thesis.conf
systemctl daemon-reload

echo "• firewall: TCP 443"
# Oracle's Ubuntu image rejects everything but SSH: allow 443 now and in the saved rules.
if ! iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT 2>/dev/null; then
  n=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
  iptables -I INPUT "${n:-1}" -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT
fi
RULES=/etc/iptables/rules.v4
if [ -f "$RULES" ] && ! grep -q -- '--dport 443 -j ACCEPT' "$RULES"; then
  sed -i '/--dport 22 -j ACCEPT/a -A INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT' "$RULES"
fi

systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
sleep 1
systemctl is-active --quiet caddy && echo "✓ caddy running for $HOST on $BIND" || { journalctl -u caddy -n 20 --no-pager; exit 1; }
