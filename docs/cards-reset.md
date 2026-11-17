# Program resets (the cards reset runbook)

A fresh-fork reset is how a new program build reaches the shared fork; card legs went live this way, with the adapter, settler and bank, program, fork API and take builder merged in that order so `main` never held card trades the live program would refuse. A reset wipes on-chain state and fake balances, and runs only on the fork maintainer's go.

## Reset steps

`<rev>` is `origin/main` after the last merge.

1. **Build the program on the Mac:**
   ```bash
   git -C .claude/worktrees/fork-main fetch origin && git -C .claude/worktrees/fork-main checkout --detach origin/main
   cd .claude/worktrees/fork-main/anchor && anchor build && shasum -a 256 target/deploy/thesis.so
   ```
   Check whether the IDL changed: `git diff --exit-code packages/chain/idl`.
2. **Copy it to the VM** and check the hash there:
   ```bash
   scp .claude/worktrees/fork-main/anchor/target/deploy/thesis.so ubuntu@<vm-host>:/tmp/thesis.so
   ssh -A ubuntu@<vm-host> 'sudo install -o thesis -g thesis -m 0644 /tmp/thesis.so /opt/thesis/anchor/target/deploy/thesis.so && sha256sum /opt/thesis/anchor/target/deploy/thesis.so'
   ```
3. **Update the VM's clone and restart with a fresh fork:**
   ```bash
   ssh -A ubuntu@<vm-host> 'git -C ~/thesis fetch origin && git -C ~/thesis checkout --detach origin/main && sudo bash ~/thesis/infra/executor/update.sh --fresh-fork'
   ```
   `target/` isn't in git, so the copied `thesis.so` stays put.
4. **Deploy the Supabase functions from `<rev>`:** always `supabase functions deploy quicknode-stream` (so its decoder matches the program's commit), plus any function the merged PRs changed (for cards: `take-builder`).
5. **Check the VM env has what the asset bank needs** (names only, never print the file):
   ```bash
   ssh -A ubuntu@<vm-host> 'sudo grep -cE "^(SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY)=" /etc/thesis/executor.env'
   ```
   It should print `2`. `COLLECTOR_CRYPT_API_KEY` is optional.
6. **Run `fork:api-e2e` on the VM** (no clock-moving suite):
   ```bash
   ssh -A ubuntu@<vm-host> 'sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/thesis/executor.env -p User=thesis -p WorkingDirectory=/opt/thesis -E HOME=/home/thesis /usr/bin/pnpm -s fork:api-e2e'
   ```
7. **Card smoke check:**
   1. Build a medium-risk take about Pokémon cards through the hosted take builder and confirm it holds cards. That writes the card's `card:` catalog row, so the asset bank tracks it.
   2. On the VM, run `node scripts/fork/cards-e2e.ts` like `fork:api-e2e`, with `CARDS_E2E_CARD` set to that card: a $25 back escrows $5 and buys no card token, a fade leaves the card out, a sale pays the escrow back.
   3. Once the bank holds the card (its cards tier runs every 15 minutes), the position's card entry is signed at insured value (`price_audit`, rule `card-insured-value`).
8. **Clean up the old fork's data** in Supabase, with the fork maintainer's OK: see "Resets" in [`scripts/fork/README.md`](../scripts/fork/README.md#resets).
9. **Tell the team it's done** (balances and takes gone, plus what each check showed) and update the README's "What's next".

## If something fails

- **The build or the hash differs:** stop before step 3. The live fork is untouched.
- **After step 3:** the fork is already fresh. Fix forward on a branch, never by hand on the VM, and re-run the failed step.
- **`fork:api-e2e` fails:** report the output to the fork maintainer before anything else.
