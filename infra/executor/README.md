# Executor hosting

Where the always-on Thesis processes run: an Oracle Cloud Always Free Ampere A1 VM, up as `thesis-executor`. It runs the team's one fork. This folder is the kit to set it up again or update it.

| Process | Fork (now) | Mainnet |
|---|---|---|
| Surfpool mainnet fork (`thesis-surfpool`, `thesis-fork-up`) | yes | no |
| Fork API for the apps (`thesis-fork-api`) | yes | no (the production backend replaces it) |
| Stream relay (`thesis-relay`) | yes | no (the QuickNode Stream delivers to the webhook) |
| Settler (`thesis-settler`) | yes | yes, with the real settler key |
| Asset-bank poller (`thesis-asset-bank`) | yes | yes |
| Marker: live take and position returns (`thesis-marker`) | yes | yes |

Logs: `journalctl -u <unit>`. What each process does: [`scripts/fork/README.md`](../../scripts/fork/README.md) (fork, fork API, relay) and [`apps/executor/README.md`](../../apps/executor/README.md) (settler, asset bank, marker).

## Why Oracle

Always Free Arm (2 OCPUs, 12 GB) runs always-on at no cost, and the stack is small (about 1.7 GB in use). Surfpool has no arm64 release binary, but its Docker image `surfpool/surfpool:1.7.0` runs on aarch64. Fly.io, Railway and Render had no free always-on option, and a laptop stops whenever it sleeps (there's one fork, here).

## Access

- **Everything listens on 127.0.0.1.** Caddy publishes the fork API over HTTPS at `https://<fork-host>` (step 9), publicly, so the apps and teammates need nothing installed. Clients take the host from their settings: `FORK_API_URL` and `NEXT_PUBLIC_FORK_API_URL` for the web app, `FORK_API_URL` in the iOS app's `Config/Fork.local.xcconfig`.
- **Tailscale Funnel is off** (2026-11-19): the web app and current iOS builds use Caddy's host, and the Blink is closed (its listener is off too: `FORK_BLINK_PORT=` in the env file). An iOS build made before Caddy still points at the old Funnel address: rebuild it with `FORK_API_URL = https:/$()/<fork-host>`. To serve the old address again for a while: `sudo tailscale funnel --bg 18901`.
- **Anyone with the URL can spend the QuickNode and Jupiter quota** behind the fork API, so it enforces [abuse limits](../../scripts/fork/README.md#abuse-limits).
- **Admin is key-only SSH** on port 22 (`ssh -A ubuntu@<vm-host>`; Ubuntu's Oracle image refuses passwords). `-A` forwards your GitHub key, which the VM uses to pull this private repo; it has no GitHub credential of its own. Tailscale SSH (`ubuntu@thesis-executor`) also works from a device on the tailnet.

## Load

Read load test (2026-11-18, from the VM through Caddy): 200 concurrent visitors, no failures; 500, no failures but p90 of 2–4 s (the VM is the limit). Through Tailscale Funnel, 19% of requests failed at 200, which is why Caddy replaced it. A load test with trades is still to do.

## Secrets

- **`/etc/thesis/executor.env`** is root-only (0600). It holds the API keys, with the same names as the repo-root `.env` (template: [`executor.env.example`](executor.env.example)). systemd reads it when it starts each service, and the services run as `thesis`, which can't open it. Never print it.
- **The settler key** is a systemd credential. `/etc/thesis/settler.json` stays root-only, and only `thesis-settler` gets a copy, in its private credentials directory.
- **On the fork,** `fork:up` also keeps the fork's own copy of the settler key in `/opt/thesis/.data/fork/settler.json` (with the admin, allowlist-admin and app-payer keys). Every service runs as `thesis`, so the fork API can read it. `fork:up` needs that file (it funds the key and names it in `init_config` on a fresh fork, and makes a new one if it's missing), and `fork:settler-e2e` and `fork:jupiter-e2e` sign with it, so it stays. It's a fork-only key; on mainnet the settler key exists only as the credential.
- **On mainnet,** the settler key moves to OCI Vault (see "Settler key in OCI Vault" below). The VM fetches it at boot with its own instance identity, so no OCI credential is stored on it. The key lives only in memory-backed `/run/thesis`.

## Hardening

- **No Docker for `thesis`.** Only `thesis-surfpool` uses Docker, and it runs as root. The `docker` group is root-equivalent, so `setup.sh` and `update.sh` take `thesis` out of it.
- **Each Thesis service** (`fork-up`, `fork-api`, `relay`, `settler`, `asset-bank`, `marker`) runs with `NoNewPrivileges=yes`, `ProtectSystem=strict` (the whole filesystem read-only, `/opt/thesis` included) with `ReadWritePaths=/opt/thesis/.data`, `ProtectHome=yes` and `PrivateTmp=yes`. Everything they write is under `.data`: the fork's keys and state, the asset bank, the settler's audit log, the relay's state.
- **Node runs each service directly** (`/usr/bin/node apps/executor/src/settler.ts`, …), the same file the `pnpm` script runs, without a ~135 MB `pnpm` wrapper per service. `pnpm` is still used for `pnpm install` and the e2e suites.
- **The datasource key stays off command lines.** `thesis-surfpool` passes `FORK_DATASOURCE_RPC_URL` to Surfpool as the `SURFPOOL_DATASOURCE_RPC_URL` environment variable (Surfpool 1.7.0 reads it in place of `--rpc-url`), and drops any journal line carrying `api-key=`.
- Still open (before phase 2): a separate user and env file per service, and code owned by root.

## Setting it up

1. **Create the network first.** In the Oracle Cloud console: Networking → Virtual cloud networks → Actions → Start VCN Wizard → "Create VCN with Internet Connectivity", defaults. (A network made inside the instance form doesn't let you assign a public IP.)
2. **Create the VM.** Image Canonical Ubuntu 24.04 (aarch64), shape VM.Standard.A1.Flex. Choose the VCN's public subnet, turn on "Automatically assign public IPv4 address", and upload your `~/.ssh/id_ed25519.pub`. 1 OCPU / 6 GB is plenty (the stack uses about 1.7 GB); 2 / 12 is the free maximum. "Out of capacity" is common on the free tier: try each availability domain, the smaller shape, or upgrade the account to Pay As You Go (the free allowance stays free).
3. **Run the setup script.** `ssh -A ubuntu@<vm-host>`, then `git clone <repo-url> ~/thesis && sudo bash ~/thesis/infra/executor/setup.sh`. It installs Docker, Node 24, pnpm and Tailscale, creates the `thesis` user (not in the `docker` group) and the app in `/opt/thesis` (cloned from `~/thesis`), pulls the Surfpool image, and installs the units. It starts nothing.
4. **Join Tailscale** with `sudo tailscale up --ssh --hostname=thesis-executor` and approve the device. Only Tailscale SSH and Funnel use it; nobody else installs Tailscale.
5. **Fill in `/etc/thesis/executor.env`.** The names match the repo-root `.env`, so copy the values over SSH without printing them, or use `sudo nano /etc/thesis/executor.env`. Set `FORK_DATASOURCE_RPC_URL` (below), and keep `FORK_API_AUTH=enforce` and `FORK_API_READ_LIMIT=enforce` from the template.
6. **Copy the program build and seed the asset bank** from a machine that builds it (`anchor build`):
   - `thesis.so` to `/opt/thesis/anchor/target/deploy/` (owner `thesis`); check its sha256.
   - `.data/asset-bank.json` to `/opt/thesis/.data/` (owner `thesis`). The fork API won't start on an empty bank, and the poller's first full sweep takes a while. Without a copy, start `thesis-asset-bank` and wait for it before starting `thesis-fork-api`.
7. **Start the fork side** with `sudo systemctl enable --now thesis-surfpool thesis-fork-up thesis-asset-bank thesis-fork-api thesis-relay`. `thesis-fork-up` runs `scripts/fork/up.ts` (`pnpm fork:up`) once Surfpool answers. That deploys the program, creates the fork's keys in `/opt/thesis/.data/fork/`, and sets up the config, the badge base and the lookup table.
8. **Hand the settler its key, and start it:** `sudo install -m 0600 /opt/thesis/.data/fork/settler.json /etc/thesis/settler.json && sudo systemctl enable --now thesis-settler`. On mainnet, the real settler key goes there instead. Then the marker (live returns, no key): `sudo systemctl enable --now thesis-marker`. It needs `MARKS_TOKEN` in the env file and the `marks` function deployed with the same secret.
9. **Publish the fork API with Caddy** (`caddy/`): HTTPS on 443 straight to the fork API.
   1. DNS: an A record for the host (e.g. `api.<domain>`) pointing at the VM's public IP.
   2. OCI console: Networking → Virtual cloud networks → the VM's VCN → Security Lists (or the subnet's) → Add Ingress Rule: source `0.0.0.0/0`, TCP, destination port `443`.
   3. `sudo bash infra/executor/caddy/setup.sh <host>`. It installs Caddy (the Ubuntu package), binds it to the VM's own address (Tailscale holds 443 on its interface while Funnel is on), opens 443 in the VM's own firewall (live and in `/etc/iptables/rules.v4`), and gets the certificate by itself. The host is kept in `/etc/thesis/caddy.env`; `update.sh` reloads the Caddyfile from then on.
   4. Check from anywhere: `curl https://<fork-host>/config`.

   The Blink is closed and Funnel is off. If the Blink comes back, it goes through Funnel: `sudo tailscale funnel --bg --https=8443 http://127.0.0.1:18902`, with `FORK_BLINK_ORIGIN` set to that URL and `FORK_BLINK_PORT` set.

## Mainnet RPC for the fork

Surfpool reads mainnet accounts through `FORK_DATASOURCE_RPC_URL` in `/etc/thesis/executor.env`: the owner's QuickNode Build plan today. Not the free QuickNode plan, which caps `getMultipleAccounts` at 5; public mainnet (the fallback when it's empty) rate-limits heavy use (`Failed to fetch accounts`). After changing it, `sudo systemctl restart thesis-surfpool thesis-fork-up`, which starts a fresh fork (Surfpool keeps its state in memory). The unit hands the URL to Surfpool through the environment, never its command line; if a key was ever shown in `ps` or the journal, rotate it in the provider's dashboard, put the new URL in the env file and restart as above.

Surfpool runs with `--disable-instruction-profiling --no-studio`: profiling cost about 145 ms per instruction on this VM (a trade's send took 1–1.5 s; now about 40 ms), and nothing uses Studio.

## Settler key in OCI Vault

For mainnet, when the settler key signs real scores. `settler-key-from-vault.sh` and `systemd/thesis-settler-key.service` are tested in a container with a stand-in `oci`, but not yet against a real Vault.

1. **Create a vault and a key** (once). In the OCI console, go to Identity & Security → Vault → Create Vault (the default type is free), then Create Key (AES, software-protected).
2. **Store the settler keypair as a secret.** In the vault: Secrets → Create Secret, using the key above, with "Plain-Text" contents set to the keypair file's JSON (`[12,34,…]`, 64 numbers). Copy the secret's OCID.
3. **Let only this VM read it.**
   - Identity → Domains → Dynamic groups → Create, with the rule `instance.id = '<the VM's OCID>'`.
   - Policies → Create, with `Allow dynamic-group <group> to read secret-bundles in compartment <compartment> where target.secret.id = '<secret OCID>'`.
4. **On the VM, as root:**
   - Install the OCI CLI: `bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)" -- --accept-all-defaults`. It goes to `/root/bin/oci`.
   - Add `OCI_SETTLER_SECRET_OCID=<secret OCID>` to `/etc/thesis/executor.env`.
   - Then run:
     ```sh
     install -D -m 0644 /opt/thesis/infra/executor/systemd/dropins/thesis-settler-vault.conf /etc/systemd/system/thesis-settler.service.d/vault.conf
     systemctl daemon-reload
     systemctl enable --now thesis-settler-key
     systemctl restart thesis-settler
     shred -u /etc/thesis/settler.json
     ```
     `thesis-settler-key` should log "settler key loaded into /run/thesis/settler.json".

## Running it

- **Code on the VM:** `/opt/thesis` is a detached checkout of `origin/main`, owned by `thesis`; `~/thesis` (user `ubuntu`) is the clone it's updated from. Never edit code in either: fix on a branch and update.
- **Updating,** the same day a PR merges that touches `anchor/programs`, `packages/chain`, `scripts/fork`, `apps/executor`, `infra/quicknode`, `infra/executor` or `supabase/functions/quicknode-stream`. Over `ssh -A`:
  1. `git -C ~/thesis fetch origin && git -C ~/thesis checkout --detach origin/main`.
  2. `sudo bash ~/thesis/infra/executor/update.sh`. It moves `/opt/thesis` to that commit, runs `pnpm install`, reinstalls the units and restarts the running services, then checks that each one is still active and the fork API answers `/health`. On a failure it names the unit, its `journalctl` line and the command to go back to the previous commit, and exits 1.
  3. **If the program changed:** build `thesis.so` from the same commit, copy it to `/opt/thesis/anchor/target/deploy/` (owner `thesis`, check the sha256), and add `--fresh-fork`, which resets the fork (on-chain state and fake balances): only on the fork maintainer's go. Deploy `quicknode-stream` from the same commit, so its IDL matches. The steps are in [`docs/cards-reset.md`](../../docs/cards-reset.md).
  4. Run `pnpm fork:api-e2e` there (below).

  A change to `thesis-surfpool.service` takes effect only when Surfpool restarts, which also resets the fork.
- **Running e2e suites on the VM**, with the services' environment (the same way for every suite):
  ```sh
  sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/thesis/executor.env \
    -p User=thesis -p WorkingDirectory=/opt/thesis -E HOME=/home/thesis /usr/bin/pnpm -s fork:api-e2e
  ```
- **Fork clock:** `fork:settler-e2e` and anything else that calls `surfnet_timeTravel` jumps the clock days ahead and breaks swaps until a restart: run it only when a change needs it, with the fork maintainer's OK. Restart with `sudo systemctl restart thesis-surfpool thesis-fork-up` (the same as `pnpm fork:down && pnpm fork:up`), then the other units; that's a fresh fork.
