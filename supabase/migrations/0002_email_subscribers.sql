-- Season-reminder email capture for pumpkinpatchesnearme.com.
--
-- Lives in its own `email` schema rather than in public, so that nothing
-- here can be reached by the same policies that make the analytics table
-- publicly readable. That difference is the whole point: the analytics
-- table holds paths and generated ids and is safe to read from the
-- browser, and this one holds email addresses and is not.
--
-- THE ACCESS MODEL, STATED PLAINLY
-- The site is static, so rows are inserted straight from the browser with
-- the anon key, which is public by design. The protection is therefore
-- entirely in the grants and policies below:
--
--   * anon may INSERT. Nothing else. There is no SELECT policy, so the
--     list cannot be read back with the anon key no matter who has it,
--     including by the person who just subscribed.
--   * Reading the list means the service-role key or the Supabase SQL
--     editor. Never ship the service-role key to the browser.
--
-- BEFORE THIS WORKS
-- PostgREST only serves schemas it has been told to expose. In the
-- Supabase dashboard: Settings -> API -> "Exposed schemas", add `email`
-- alongside `public`. Without that the inserts below 404, and the form
-- will tell the visitor it could not save rather than failing silently.
--
-- Run once against the project (SQL editor or `supabase db push`).

create schema if not exists email;

-- usage only: the grants on the table decide what can actually be done
grant usage on schema email to anon, authenticated;

create table if not exists email.subscribers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Normalised client-side too, but not trusted from there.
  address text not null check (
    length(address) between 6 and 254
    and address = lower(address)
    -- Deliberately loose. Anything stricter rejects real addresses, and
    -- the only test that settles deliverability is sending to it.
    and address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),

  -- What they asked to hear about. The promise made on the form is
  -- "we will tell you when <state>'s patches open", so the state is the
  -- segment the send is built on, not a nice-to-have.
  state text check (state is null or length(state) <= 60),

  -- Where they signed up, for working out which pages are worth a form.
  source_path text check (source_path is null or length(source_path) <= 300),

  -- An explicit record that the box was ticked and when. Keep it: it is
  -- the only evidence of consent that exists for a browser-side signup.
  consent boolean not null default false check (consent = true),
  consent_at timestamptz not null default now(),

  -- Set by whatever sends the mail, never by the browser.
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  last_sent_at timestamptz
);

-- One row per address. Case is already forced to lower by the check
-- above, so a plain unique index is enough and stays usable as an index.
create unique index if not exists idx_email_subscribers_address
  on email.subscribers (address);
create index if not exists idx_email_subscribers_state
  on email.subscribers (state) where unsubscribed_at is null;
create index if not exists idx_email_subscribers_created_at
  on email.subscribers (created_at);

alter table email.subscribers enable row level security;

-- INSERT only, and only the columns a visitor has any business setting.
-- The rest keep their defaults or stay null until the sender fills them.
revoke all on email.subscribers from anon, authenticated;
grant insert (address, state, source_path, consent) on email.subscribers to anon, authenticated;

drop policy if exists "Anon may subscribe" on email.subscribers;
create policy "Anon may subscribe" on email.subscribers
  for insert to anon, authenticated
  with check (
    consent = true
    and confirmed_at is null
    and unsubscribed_at is null
    and last_sent_at is null
  );

-- No SELECT, UPDATE or DELETE policy exists on purpose. With RLS enabled
-- and no policy for those commands, they are denied for anon even though
-- the key is public. Do not add one "to check for duplicates" -- a
-- duplicate already surfaces as a 23505 unique violation, which the form
-- handles, and a SELECT policy would turn the whole list into a public
-- endpoint.

comment on table email.subscribers is
  'Season-reminder signups from the static site. Insert-only for anon; read with the service role.';

-- A note on what this does not solve: with no server in front of it, a
-- determined script can still POST rows. The form has a honeypot and a
-- timing check, and the constraints above keep junk out of the shape of
-- the data, but the real answer when it starts mattering is a Turnstile
-- check in an edge function that holds the service-role key. Until then,
-- expect to filter the list before the first send.
