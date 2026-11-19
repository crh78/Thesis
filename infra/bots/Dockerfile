# The chat bots (infra/bots/run.mts) as one Railway service. Build context: the repo root.
FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @thesis/imessage... --filter @thesis/x...
ENV NODE_ENV=production
CMD ["node", "infra/bots/run.mts"]
