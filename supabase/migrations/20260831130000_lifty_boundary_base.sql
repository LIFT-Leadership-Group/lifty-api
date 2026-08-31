-- LIF-625 — LIFTY dedicated Supabase boundary: base tables.
--
-- This migration root belongs to the LIFTY projects ONLY (staging
-- `siafcvcdhenahviuoxer`, production TBD). It is not the GTM Engine catalog
-- and must never be applied there; the GTM copies of these tables live in
-- lift-supabase-functions with a much larger surface.
--
-- Only the columns that the LIF-607 RPCs (get_lifty_workspace_status,
-- provision_lifty_workspace) read or write exist here. The GTM `workspaces`
-- table carries dozens of pipeline knobs; none of them are part of the public
-- LIFTY contract, so none of them cross this boundary. Internal GTM jobs reach
-- LIFTY data through a private bridge contract, never the other way around.
--
-- Defaults deviate from GTM deliberately, toward the safe-at-rest posture:
-- pipeline_active defaults FALSE (GTM: true) and every review gate defaults
-- TRUE (GTM: false). provision_lifty_workspace() sets all of them explicitly,
-- so the defaults only matter for rows created outside the RPC — and those
-- must also be inert by default.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  outreach_context jsonb not null default '{}'::jsonb,
  tier text not null default 'tier_1',
  is_active boolean not null default true,
  pipeline_active boolean not null default false,
  auto_reply_enabled boolean not null default false,
  first_dm_review_enabled boolean not null default true,
  linkedin_review_enabled boolean not null default true,
  email_review_enabled boolean not null default true,
  allow_hubspot_provisioning boolean not null default false,
  apollo_phone_reveal_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_slug_key unique (slug),
  constraint workspaces_tier_check check (tier in ('tier_1', 'tier_2'))
);

comment on table public.workspaces is
  'LIF-625: minimal LIFTY workspace record. One row per founder workspace, written only by public.provision_lifty_workspace(). No pipeline catalog columns cross this boundary.';

create table public.workspace_memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, workspace_id)
);

comment on table public.workspace_memberships is
  'LIF-625: founder-to-workspace membership. Written only by public.provision_lifty_workspace().';

-- Foreign-key index (user_id is covered by the primary key's leading column).
create index workspace_memberships_workspace_id_idx
  on public.workspace_memberships (workspace_id);

-- Founder JWTs never touch these tables directly: every read and write goes
-- through the SECURITY DEFINER RPCs. RLS is enabled with NO policies, and the
-- Supabase default grants are stripped, so the fence holds by two independent
-- mechanisms. anon must be named explicitly — REVOKE ... FROM PUBLIC does not
-- strip a grant held directly by anon.
alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;

revoke all on table public.workspaces from public, anon, authenticated;
revoke all on table public.workspace_memberships from public, anon, authenticated;
