-- What the chat bots did, for looking back: every mention the X bot handled (replied, skipped and
-- why, refused by X, failed), its starts and stops, and poll failures. Railway's logs scroll away;
-- this is the record. Written by functions/source (POST /source/bot-events, x-bot-secret), which
-- the bots call after each poll. Service role only.
--
--   bot     x | imessage
--   event   replied | would reply (dry run) | skip | reply refused | reply failed | plan failed |
--           image failed | poll failed | starting | stopped
--   ref     the mention's post id (X), when the event is about one
--   author  the X username ("@jake") or a masked handle; never an iMessage number in full
--   what    the reply's kind: take, trade, sell, no_exposure, explain, not_linked, opt_out, ...
--   data    everything else the bot logged: the reply's text, its id, the mention's text, the
--           skip reason, the trade, whether it had a picture
--
-- Kept 90 days.

create table public.bot_events (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  bot     text not null check (bot in ('x', 'imessage')),
  event   text not null check (char_length(event) between 1 and 60),
  ref     text check (ref is null or char_length(ref) <= 60),
  author  text check (author is null or char_length(author) <= 60),
  what    text check (what is null or char_length(what) <= 40),
  data    jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 16000)
);

create index bot_events_at on public.bot_events (at desc);
create index bot_events_event on public.bot_events (bot, event, at desc);

alter table public.bot_events enable row level security;
revoke all on public.bot_events from anon, authenticated;

select cron.schedule('bot-events-prune', '17 4 * * *', $$delete from public.bot_events where at < now() - interval '90 days'$$);
