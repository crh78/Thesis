# Chat bots on Railway

Both chat bots run as one Railway service: the iMessage bot (`apps/imessage`, on Sendblue) and the
X bot (`apps/x`, @yourthesisxyz). `run.mts` starts each one as its own process and tags its log
lines (`[imessage] …`, `[x] …`). If either exits, the service exits and Railway restarts it.

- The X bot starts only when all four X keys are set; until then the iMessage bot runs alone.
- `BOTS_IMESSAGE=0` or `BOTS_X=0` turns a bot off.
- Both poll (Sendblue's free plan has no webhooks), so the service needs no public URL or port.
- iMessage group chats need BlueBubbles on a Mac (`apps/imessage/README.md`), not this service.

## Setup

Railway project `thesis-bots`, service `bots`:

- **Build:** `RAILWAY_DOCKERFILE_PATH=infra/bots/Dockerfile` (build context: the repo root;
  `.dockerignore` keeps only the bots and their workspace packages).
- **Volume** mounted at `/data`, with `X_STATE_FILE=/data/x-state.json`. That file is how the X bot
  never answers a mention twice across restarts and redeploys.
- **Variables:** everything in `apps/imessage/.env.example` and `apps/x/.env.example`. The bots
  need only `THESIS_BOT_SECRET` from Thesis (the Vault's `bot_secret`), plus `SUPABASE_URL`,
  `OPENAI_API_KEY` and the Sendblue keys. The X bot is live (`X_DRY_RUN` unset since
  2026-11-20); `X_UNLIMITED` lifts the reply caps for the team's accounts. Trading, scores and
  copy go through the `agent` function with the same bot secret. Rotating it means the Vault's
  `bot_secret`, a redeploy of the `agent` and `source` functions (they cache it), then
  `THESIS_BOT_SECRET` here.

Deploy `main`, from a clean export, never the working tree (it would upload local folders such as
`.claude/`, and changes that aren't merged):

```sh
dir=$(mktemp -d) && git archive origin/main | tar -x -C "$dir" && cd "$dir"
railway link -p thesis-bots -s bots -e production
railway up --service bots --ci
railway logs --service bots
```

Changing a variable doesn't always redeploy: `railway redeploy --service bots -y` after deleting one.

Run it locally the same way: `node infra/bots/run.mts` with the bots' variables in the environment.
