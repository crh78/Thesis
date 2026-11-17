# @thesis/agent

Chat agent brain, independent of transport: one OpenAI Responses call per inbound message (Luna), with tools for what a chat can do. Today that's `build_basket` (a take → a basket, through the `take-builder` edge function, answered with a link that opens it in the app). Backing and fading by text ("I'm in for $50 on Jake's take", "Fading Jake for $25") come later. Used by `apps/imessage`; Telegram / Discord / WhatsApp later.

Try it without iMessage: `pnpm --filter @thesis/agent chat "AI power demand is underrated"` (add `--group` for group behaviour).
