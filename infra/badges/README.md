# Badge metadata

Each "called it" badge is a non-transferable Token-2022 mint whose metadata extension points at a
JSON file here:

```
<SUPABASE_URL>/storage/v1/object/public/badges/<slug>.json   name, symbol, description, image, attributes
<SUPABASE_URL>/storage/v1/object/public/badges/<slug>.png    512×512
```

| Badge | Slug | On-chain name |
|---|---|---|
| First take posted | `first-take` | Thesis: First take |
| First take at +50% | `first-50` | Called it: +50% |
| First take at +100% | `first-100` | Called it: +100% |
| Ten takes at +50% | `ten-50` | Called it: 10x +50% |
| A take at +1,000% | `over-1000` | Called it: +1,000% |

- **Where badges point.** The program builds each badge's URI as `{badge_uri_base}{slug}.json`,
  from the config account. The admin changes `badge_uri_base` with `update_config` (an `https://`
  URL ending in `/`, at most 128 bytes), so the host can move without a program upgrade.
- **Badges already minted** keep the URI they were minted with.
- **New configs.** A new config starts with a placeholder base. `pnpm fork:up` points the fork's
  config at this bucket. On mainnet, set the base with `update_config` before the first badge
  is minted.
- **The bucket** is public: wallets and explorers fetch with no key. Only the service role can
  write to it. It comes from `supabase/migrations/*_badges_bucket.sql`.

## Changing a badge

```sh
pnpm badges:render        # swift infra/badges/render.swift: images/<slug>.png (CoreGraphics, the app's Geist fonts and palette)
pnpm badges:upload        # images and metadata JSON to the bucket (replaces them)
pnpm badges:upload -- --dry   # print the metadata only
```

The upload uses `SUPABASE_SERVICE_ROLE_KEY` when it's set. Without it, it goes through the
Supabase CLI's login and linked project (`supabase login`, `supabase link`). Names and slugs come
from `BADGE_META` in `@thesis/chain`, and a test checks them against the program.
