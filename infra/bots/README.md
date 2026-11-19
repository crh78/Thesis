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
  `OPENAI_API_KEY` and the Sendblue keys. Keep `X_DRY_RUN=1` until the dry-run replies look
  right and X has approved the bot (`apps/x/README.md`).

Deploy from the repo root:

```sh
railway up --service bots      # uploads the repo (minus .gitignore'd files) and builds
railway logs --service bots
```

Run it locally the same way: `node infra/bots/run.mts` with the bots' variables in the environment.
