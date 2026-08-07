-- Analytics for pumpkinpatchesnearme.com.
--
-- pumpkinpatchesnearme.com is a static site (no server/API routes), so
-- events are inserted directly from the browser with the anon key rather
-- than through a backend admin client. The table is named per-directory
-- (not a shared "analytics_events") because one Supabase project hosts
-- analytics for several of this operator's directory sites.
--
-- Run this once against your Supabase project (SQL editor, or
-- `supabase db push` if you use the CLI) before setting SUPABASE_URL /
-- SUPABASE_ANON_KEY in the site's build environment.

create table if not exists public.pumpkinpatchesnearme_dashboard (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null check (
    event_type in ('pageview', 'listing_view', 'call_click', 'directions_click', 'search', 'review_click')
  ),
  path text,
  referrer text,
  session_id text,
  visitor_id text,
  listing_slug text,
  listing_name text,
  city text,
  query text
);

create index if not exists idx_ppnm_dashboard_created_at on public.pumpkinpatchesnearme_dashboard (created_at);
create index if not exists idx_ppnm_dashboard_event_type on public.pumpkinpatchesnearme_dashboard (event_type);
create index if not exists idx_ppnm_dashboard_listing_slug on public.pumpkinpatchesnearme_dashboard (listing_slug);
create index if not exists idx_ppnm_dashboard_path on public.pumpkinpatchesnearme_dashboard (path);
create index if not exists idx_ppnm_dashboard_session_id on public.pumpkinpatchesnearme_dashboard (session_id);

alter table public.pumpkinpatchesnearme_dashboard enable row level security;

-- Public SELECT: the dashboard's live activity panel subscribes to this
-- table via Supabase Realtime from the browser, and there is no server to
-- proxy the read through. The table holds no PII — just paths, event
-- types and browser-generated session/visitor ids — so public read is an
-- intentional tradeoff, not an oversight.
drop policy if exists "Public read access" on public.pumpkinpatchesnearme_dashboard;
create policy "Public read access" on public.pumpkinpatchesnearme_dashboard
  for select using (true);

-- Public INSERT: same reasoning, and the same tradeoff a Next.js version
-- of this dashboard avoids by inserting through a service-role API route.
-- Without a backend, the CHECK constraint on event_type is the only server
-- side guardrail on what gets written — treat this table as append-only,
-- untrusted-input analytics, not a source of truth for anything billed or
-- security-sensitive. If abuse becomes a problem, move inserts behind a
-- Supabase Edge Function that can rate-limit before writing.
drop policy if exists "Public insert access" on public.pumpkinpatchesnearme_dashboard;
create policy "Public insert access" on public.pumpkinpatchesnearme_dashboard
  for insert with check (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pumpkinpatchesnearme_dashboard'
  ) then
    alter publication supabase_realtime add table public.pumpkinpatchesnearme_dashboard;
  end if;
end $$;

-- Aggregate RPCs -------------------------------------------------------
-- The dashboard calls these instead of pulling raw rows into the browser
-- and aggregating client-side, which would not scale past a small number
-- of events. All three are read-only and safe to expose to anon given the
-- table itself is already public-read.

create or replace function public.pumpkinpatchesnearme_dashboard_stats(days int)
returns table (
  sessions bigint,
  visitors bigint,
  lead_actions bigint,
  searches bigint,
  impressions bigint
)
language sql
stable
as $$
  select
    count(distinct session_id) filter (where session_id is not null) as sessions,
    count(distinct visitor_id) filter (where visitor_id is not null) as visitors,
    count(*) filter (where event_type in ('call_click', 'directions_click', 'review_click')) as lead_actions,
    count(*) filter (where event_type = 'search') as searches,
    count(*) filter (where event_type in ('pageview', 'listing_view')) as impressions
  from public.pumpkinpatchesnearme_dashboard
  where created_at >= now() - (days || ' days')::interval;
$$;

create or replace function public.pumpkinpatchesnearme_dashboard_daily(days int)
returns table (
  day date,
  pageviews bigint,
  listing_views bigint,
  lead_actions bigint,
  searches bigint
)
language sql
stable
as $$
  select
    date_trunc('day', created_at)::date as day,
    count(*) filter (where event_type = 'pageview') as pageviews,
    count(*) filter (where event_type = 'listing_view') as listing_views,
    count(*) filter (where event_type in ('call_click', 'directions_click', 'review_click')) as lead_actions,
    count(*) filter (where event_type = 'search') as searches
  from public.pumpkinpatchesnearme_dashboard
  where created_at >= now() - (days || ' days')::interval
  group by 1
  order by 1;
$$;

create or replace function public.pumpkinpatchesnearme_dashboard_by_action(days int)
returns table (
  event_type text,
  total bigint
)
language sql
stable
as $$
  select event_type, count(*) as total
  from public.pumpkinpatchesnearme_dashboard
  where created_at >= now() - (days || ' days')::interval
  group by 1
  order by 2 desc;
$$;

create or replace function public.pumpkinpatchesnearme_dashboard_by_business(days int)
returns table (
  listing_slug text,
  listing_name text,
  city text,
  directions_clicks bigint,
  call_clicks bigint,
  review_clicks bigint,
  views bigint,
  total bigint
)
language sql
stable
as $$
  select
    listing_slug,
    max(listing_name) as listing_name,
    max(city) as city,
    count(*) filter (where event_type = 'directions_click') as directions_clicks,
    count(*) filter (where event_type = 'call_click') as call_clicks,
    count(*) filter (where event_type = 'review_click') as review_clicks,
    count(*) filter (where event_type = 'listing_view') as views,
    count(*) as total
  from public.pumpkinpatchesnearme_dashboard
  where created_at >= now() - (days || ' days')::interval
    and listing_slug is not null
  group by 1
  order by total desc;
$$;

grant execute on function public.pumpkinpatchesnearme_dashboard_stats(int) to anon;
grant execute on function public.pumpkinpatchesnearme_dashboard_daily(int) to anon;
grant execute on function public.pumpkinpatchesnearme_dashboard_by_action(int) to anon;
grant execute on function public.pumpkinpatchesnearme_dashboard_by_business(int) to anon;
