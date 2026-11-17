#!/usr/bin/env bash
# Fetches the settler's keypair from OCI Vault into /run/thesis/settler.json (memory-backed,
# root only), for thesis-settler to load as a systemd credential. Runs as root from
# thesis-settler-key.service at boot; nothing is written to disk.
#
# Needs: the OCI CLI (`oci`), the secret's OCID in OCI_SETTLER_SECRET_OCID (in
# /etc/thesis/executor.env), and the instance allowed to read it through a dynamic group
# (infra/executor/README.md, "Settler key in OCI Vault"). The VM signs in with its own instance
# principal, so no OCI credential is stored on it.
set -euo pipefail

out="${1:-/run/thesis/settler.json}"
: "${OCI_SETTLER_SECRET_OCID:?set OCI_SETTLER_SECRET_OCID in /etc/thesis/executor.env}"
oci_bin="$(command -v oci || echo /root/bin/oci)"

umask 077
tmp="$(mktemp "$(dirname "$out")/.settler.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
"$oci_bin" secrets secret-bundle get --secret-id "$OCI_SETTLER_SECRET_OCID" --auth instance_principal \
  --query 'data."secret-bundle-content".content' --raw-output | base64 -d > "$tmp"

# A Solana CLI keypair file: a JSON array of 64 bytes. Refuse anything else rather than start the
# settler with a wrong key.
if ! python3 -c 'import json,sys; k=json.load(open(sys.argv[1])); assert isinstance(k,list) and len(k)==64 and all(isinstance(b,int) and 0<=b<256 for b in k)' "$tmp" 2>/dev/null; then
  echo "the secret isn't a Solana keypair (a JSON array of 64 bytes)" >&2
  exit 1
fi
mv "$tmp" "$out"
trap - EXIT
echo "settler key loaded into $out"
