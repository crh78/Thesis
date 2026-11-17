# @thesis/agent

Chat agent brain, independent of transport: one OpenAI Responses call per inbound message (Luna), with tools for what a chat can do. Today that's `build_basket`: a take → the `source` function's `POST /source/drafts` (`THESIS_BOT_SECRET`), which runs the `take-builder` and saves the basket as a **draft take**. The answer is the draft's web page (`WEB_URL/d/<id>`), where whoever taps posts it as their take. Backing and fading by text ("I'm in for $50 on Jake's take") comes later, with Privy session signers.

Used by `apps/imessage` (the chat agent) and `apps/x` (`buildBasket` only; X has its own vetting and reply templates).

Try it without iMessage: `pnpm --filter @thesis/agent chat "AI power demand is underrated"` (add `--group` for group behaviour).
