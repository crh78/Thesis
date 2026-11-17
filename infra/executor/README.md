# Executor hosting

Where the always-on Thesis processes run: an Oracle Cloud Always Free Ampere A1 VM. It's up as `thesis-executor` and runs the team's one fork; this folder is the kit
to set it up again or update it.

| Process | Fork (now) | Mainnet |
|---|---|---|
| Surfpool mainnet fork (`thesis-surfpool`, `thesis-fork-up`) | yes | no |
| Fork API for the app (`thesis-fork-api`) | yes | no (the production backend replaces it) |
| Stream relay (`thesis-relay`) | yes | no (the QuickNode Stream delivers to the webhook) |
| Settler (`thesis-settler`) | yes | yes, with the real settler key |
| Asset-bank poller (`thesis-asset-bank`) | yes | yes |
| Marker: live take and position returns (`thesis-marker`) | yes | yes |

## Why Oracle

Always Free Arm (2 OCPUs, 12 GB) runs always-on at no cost, and the stack is small (about 1.7 GB in use). Surfpool has no arm64 release binary, but its Docker image `surfpool/surfpool:1.7.0` runs on aarch64. Fly.io, Railway and Render had no free always-on option; the old Mac LaunchAgent stopped whenever the laptop slept and was removed (there's one fork, here).

## Access

- **Everything listens on 127.0.0.1.** Tailscale Funnel publishes the fork API and the fork Blink
  over HTTPS, publicly, so the app and teammates need nothing installed:
  - fork API: `https://<fork-host>` (`FORK_API_URL`; the iOS app reads it from
    `apps/ios/Config/Fork.local.xcconfig`, see its `.example`)
  - fork Blink: `https://<fork-host>:8443`, whose listener is off
    (`FORK_BLINK_PORT=` in the env file; the Blink is closed)

  Anyone with the URL can spend the Helius and Jupiter quota behind it, so the fork API has
  [abuse limits](../../scripts/fork/README.md#abuse-limits), in report mode until switched to enforce.
- **Admin is key-only SSH** on port 22 (`ssh -A ubuntu@<public IP>`; Ubuntu's Oracle image refuses
  passwords). `-A` forwards your GitHub key, which the VM uses to pull this private repo. Tailscale
  SSH (`tailscale up --ssh`) also works from a device on the tailnet; with it, the port 22 rule can
  go.

## Secrets

- **`/etc/thesis/executor.env`** is root-only (0600). It holds the API keys, with the same names as the
  repo-root `.env` (template: `executor.env.example`). systemd reads it when it starts each
  service, and the services run as `thesis`, which can't open it.
- **The settler key** is a systemd credential. `/etc/thesis/settler.json` stays root-only, and only
  `thesis-settler` gets a copy, in its private credentials directory.
- **On mainnet,** the settler key moves to OCI Vault (see "Settler key in OCI Vault" below). The VM
  fetches it at boot with its own instance identity, so no OCI credential is stored on it. The
  key lives only in memory-backed `/run/thesis`.

## Setting it up

1. **Create the network first.** In the Oracle Cloud console: Networking → Virtual cloud
   networks → Actions → Start VCN Wizard → "Create VCN with Internet Connectivity", defaults. (A
   network made inside the instance form doesn't let you assign a public IP.)
2. **Create the VM.** Image Canonical Ubuntu 24.04 (aarch64), shape VM.Standard.A1.Flex. Choose the
   VCN's public subnet, turn on "Automatically assign public IPv4 address", and upload your Mac's
   `~/.ssh/id_ed25519.pub`. 1 OCPU / 6 GB is plenty (the stack uses about 1.7 GB); 2 / 12 is the
   free maximum. "Out of capacity" is common on the free tier: try each availability domain, the
   smaller shape, or upgrade the account to Pay As You Go (the free allowance stays free).
3. **Run the setup script.** `ssh -A ubuntu@<public IP>`, then
   `git clone <repo-url> ~/thesis && sudo bash ~/thesis/infra/executor/setup.sh`.
   It installs Docker, Node 24, pnpm and Tailscale, creates the `thesis` user and the app in
   `/opt/thesis` (cloned from `~/thesis`), pulls the Surfpool image, and installs the units. It
   starts nothing.
4. **Join Tailscale** with `sudo tailscale up --ssh --hostname=thesis-executor` and approve the
   device. Funnel needs it, even though nobody else installs Tailscale.
5. **Fill in `/etc/thesis/executor.env`.** The names match the Mac's repo-root `.env`, so copy the
   values over SSH without printing them, or use `sudo nano /etc/thesis/executor.env`. Set
   `FORK_BLINK_ORIGIN` to the Blink's Funnel URL (step 9).
6. **Copy the program build and seed the asset bank** from a machine that builds it (`anchor build`):
   - `thesis.so` to `/opt/thesis/anchor/target/deploy/` (owner `thesis`); check its sha256.
   - `.data/asset-bank.json` to `/opt/thesis/.data/` (owner `thesis`). The fork API won't start on
     an empty bank, and the poller's first full sweep takes a while. Without a copy, start
     `thesis-asset-bank` and wait for it before starting `thesis-fork-api`.
7. **Start the fork side** with
   `sudo systemctl enable --now thesis-surfpool thesis-fork-up thesis-asset-bank thesis-fork-api thesis-relay`.
   `thesis-fork-up` runs `pnpm fork:up` once Surfpool answers. That deploys the program, creates
   the fork's keys in `/opt/thesis/.data/fork/`, and sets up the config, the badge base and the
   lookup table.
8. **Hand the settler its key, and start it:**
   `sudo install -m 0600 /opt/thesis/.data/fork/settler.json /etc/thesis/settler.json && sudo systemctl enable --now thesis-settler`.
   On mainnet, the real settler key goes there instead.
   Then the marker (live returns, no key): `sudo systemctl enable --now thesis-marker`. It needs
   `MARKS_TOKEN` in the env file and the `marks` function deployed with the same secret.
9. **Publish with Funnel.** The first run prints a link to turn Funnel on for the tailnet; approve
   it and run again:
   ```sh
   sudo tailscale funnel --bg --https=443 http://127.0.0.1:18901    # fork API
   sudo tailscale funnel --bg --https=8443 http://127.0.0.1:18902   # fork Blink
   ```
   Check from anywhere: `curl https://<fork-host>/config`.

## Mainnet RPC for the fork

Set `FORK_DATASOURCE_RPC_URL` in `/etc/thesis/executor.env` (Helius free plan today; not the free QuickNode plan, which caps `getMultipleAccounts` at 5), then `sudo systemctl restart thesis-surfpool thesis-fork-up`. Public mainnet rate-limits heavy use (`Failed to fetch accounts`).

## Settler key in OCI Vault

For mainnet, when the settler key signs real scores. `settler-key-from-vault.sh` and
`systemd/thesis-settler-key.service` are tested in a container with a stand-in `oci`, but not yet
against a real Vault.

1. **Create a vault and a key** (once). In the OCI console, go to Identity & Security → Vault →
   Create Vault (the default type is free), then Create Key (AES, software-protected).
2. **Store the settler keypair as a secret.** In the vault: Secrets → Create Secret, using the key
   above, with "Plain-Text" contents set to the keypair file's JSON (`[12,34,…]`, 64 numbers).
   Copy the secret's OCID.
3. **Let only this VM read it.**
   - Identity → Domains → Dynamic groups → Create, with the rule `instance.id = '<the VM's OCID>'`.
   - Policies → Create, with
     `Allow dynamic-group <group> to read secret-bundles in compartment <compartment> where target.secret.id = '<secret OCID>'`.
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

- **Logs:** `journalctl -u thesis-settler -f`. Use the same pattern for any unit.
- **Updating** (the same day a PR merges that touches the fork's code; see CLAUDE.md, "The one
  fork"): over `ssh -A`, run `git -C ~/thesis fetch origin && git -C ~/thesis checkout --detach origin/main`,
  then `sudo bash ~/thesis/infra/executor/update.sh`. It moves `/opt/thesis` to that commit, runs
  `pnpm install`, reinstalls the units and restarts the running services. For a new program
  build, copy `thesis.so` first and add `--fresh-fork`, which resets the fork.
- **Running e2e suites on the VM**, with the services' environment:
  ```sh
  sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/thesis/executor.env \
    -p User=thesis -p WorkingDirectory=/opt/thesis -E HOME=/home/thesis /usr/bin/pnpm -s fork:api-e2e
  ```
- **Fork clock:** a fresh fork resets the clock and the fork's state. Restart it with
  `sudo systemctl restart thesis-surfpool thesis-fork-up`, the same as `pnpm fork:down && pnpm fork:up`.

The settler reads open positions from `chain_positions` rather than scanning the program each tick ([`apps/executor/README.md`](../../apps/executor/README.md)).
