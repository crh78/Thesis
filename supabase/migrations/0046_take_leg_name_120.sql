-- Leg names up to 120 characters. Collector Crypt card titles run to ~104
-- characters and Polymarket/Gemini prediction names ("When will Justice Alito retire from the
-- Supreme Court: Before Jan 1, 2027") to ~108, so a basket holding one couldn't be posted: the
-- 60-character limit refused it. Names stay off chain, so this is the only limit.
-- Not purely additive: it drops and re-adds the check, wider. Every existing row already passes.
alter table public.take_legs drop constraint take_legs_name_len;
alter table public.take_legs add constraint take_legs_name_len check (char_length(name) between 1 and 120);
