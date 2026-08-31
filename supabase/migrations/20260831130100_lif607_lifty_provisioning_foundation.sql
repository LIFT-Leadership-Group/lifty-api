-- LIF-607 / LIFTY P2.1 — provisioning database foundation.
--
-- WHAT THIS IS
-- ------------
-- `lifty push` calls public.provision_lifty_workspace(draft) directly through
-- PostgREST with the founder's user JWT and the *public anon key*. There is no
-- service-role key anywhere on that path, so RLS plus this SECURITY DEFINER
-- function are the entire server-side boundary. Treat every input as hostile.
--
-- Objects created here:
--   * public.lifty_onboarding_submissions  — append-only receipt of one accepted draft
--   * private.lifty_*                      — validation / canonicalisation helpers
--   * public.get_lifty_workspace_status()  — read-only actor state probe
--   * public.provision_lifty_workspace()   — the one write path
--
-- Membership reuses the existing public.workspace_memberships table (see
-- "MEMBERSHIP" below). No new membership table is created.
--
-- PAYLOAD CAPS (public endpoint hardening — documented, enforced below)
--   max serialized draft bytes ......... 131072  (128 KiB)
--   max nesting depth .................. 12
--   max total JSON nodes ............... 5000
--   max chars in any JSON string ....... 4000
--   max chars in any object key ........ 200
--   max array elements / object keys ... 200
--   max workspace name chars ........... 200 (truncated, not rejected)
-- The LIFT worked-example draft is ~3 KiB, depth 6, 107 nodes, so these caps
-- leave one to two orders of magnitude of headroom over a realistic draft while
-- still bounding the work a single anon-key request can force the database to do.
--
-- ERROR CONTRACT (no draft content ever appears in a message or the logs)
--   PT401  unauthenticated
--   PT400  lifty_draft_invalid: <reason_code>        -- reason codes are fixed literals
--   PT413  lifty_draft_too_large: <limit_code>
--   PT409  workspace_already_exists                  -- different draft, actor already has a workspace
--   PT409  provisioning_conflict                     -- lost an unresolvable concurrent race
-- The PTxxx SQLSTATEs are PostgREST's "raise the HTTP status" convention; the
-- message text repeats the code so a client can match on either.

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------

create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Append-only submission receipt
-- ---------------------------------------------------------------------------

create table if not exists public.lifty_onboarding_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  schema_version text not null,
  normalized_draft jsonb not null,
  draft_digest text not null,
  import_status text not null default 'pending',
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'lifty_onboarding_submissions_draft_digest_format'
      and conrelid = 'public.lifty_onboarding_submissions'::regclass
  ) then
    alter table public.lifty_onboarding_submissions
      add constraint lifty_onboarding_submissions_draft_digest_format
      check (draft_digest ~ '^sha256:[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'lifty_onboarding_submissions_import_status_check'
      and conrelid = 'public.lifty_onboarding_submissions'::regclass
  ) then
    alter table public.lifty_onboarding_submissions
      add constraint lifty_onboarding_submissions_import_status_check
      check (import_status in ('pending', 'imported', 'failed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'lifty_onboarding_submissions_schema_version_check'
      and conrelid = 'public.lifty_onboarding_submissions'::regclass
  ) then
    alter table public.lifty_onboarding_submissions
      add constraint lifty_onboarding_submissions_schema_version_check
      check (schema_version = '1.0');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'lifty_onboarding_submissions_draft_object_check'
      and conrelid = 'public.lifty_onboarding_submissions'::regclass
  ) then
    alter table public.lifty_onboarding_submissions
      add constraint lifty_onboarding_submissions_draft_object_check
      check (jsonb_typeof(normalized_draft) = 'object');
  end if;
end
$$;

-- Idempotency key. Deliberately a PLAIN, NON-PARTIAL unique index: partial
-- unique indexes break PostgREST's upsert inference in this codebase, and the
-- ON CONFLICT / exception path in provision_lifty_workspace() depends on this
-- index existing exactly as written.
create unique index if not exists lifty_onboarding_submissions_user_digest_key
  on public.lifty_onboarding_submissions (user_id, draft_digest);

-- Foreign-key index (Postgres does not create one automatically); user_id is
-- already covered as the leading column of the unique index above.
create index if not exists lifty_onboarding_submissions_workspace_id_idx
  on public.lifty_onboarding_submissions (workspace_id);

comment on table public.lifty_onboarding_submissions is
  'LIF-607: append-only receipt of one accepted LIFTY onboarding draft per (user, draft_digest). Written only by public.provision_lifty_workspace(); UPDATE is always blocked and DELETE is allowed only as orphan cleanup behind a cascading auth.users / workspaces delete.';
comment on column public.lifty_onboarding_submissions.normalized_draft is
  'Canonical (recursively key-sorted) jsonb form of the founder draft. draft_digest is the sha256 of its text serialization.';
comment on column public.lifty_onboarding_submissions.draft_digest is
  'sha256:<64 lowercase hex>. Idempotency key together with user_id.';
comment on column public.lifty_onboarding_submissions.import_status is
  'Lifecycle of the downstream draft import. P2.1 only ever writes ''pending'' — the table is append-only, so a later phase needs either a trigger exemption for this column alone or a separate import ledger.';

alter table public.lifty_onboarding_submissions enable row level security;

-- Owners may read their own submissions. There is deliberately no INSERT /
-- UPDATE / DELETE policy for authenticated: every write goes through the RPC.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'lifty_onboarding_submissions'
      and policyname = 'lifty_onboarding_submissions_select_own'
  ) then
    create policy lifty_onboarding_submissions_select_own
      on public.lifty_onboarding_submissions
      for select
      to authenticated
      using (user_id = (select auth.uid()));
  end if;
end
$$;

-- Supabase default privileges hand anon + authenticated ALL on every new public
-- table. RLS already denies the write commands (no policy), but strip the raw
-- grants too so the fence does not rest on a single mechanism.
revoke all on table public.lifty_onboarding_submissions from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.lifty_onboarding_submissions from authenticated;
grant select on table public.lifty_onboarding_submissions to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Immutability trigger
-- ---------------------------------------------------------------------------
-- Blocks UPDATE unconditionally, for every role including postgres and
-- service_role. Blocks DELETE too, except when the row is already orphaned —
-- that is the state a cascading delete of auth.users / public.workspaces leaves
-- behind, and without the exemption deleting a user would error out.

create or replace function private.lifty_submissions_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'lifty_onboarding_submissions is append-only'
      using errcode = '42501';
  end if;

  if exists (select 1 from auth.users u where u.id = old.user_id)
     and exists (select 1 from public.workspaces w where w.id = old.workspace_id)
  then
    raise exception 'lifty_onboarding_submissions is append-only'
      using errcode = '42501';
  end if;

  return old;
end;
$$;

comment on function private.lifty_submissions_immutable() is
  'LIF-607: enforces append-only semantics on public.lifty_onboarding_submissions. DELETE passes only for rows whose owning user or workspace is already gone (cascade cleanup).';

drop trigger if exists lifty_onboarding_submissions_immutable
  on public.lifty_onboarding_submissions;
create trigger lifty_onboarding_submissions_immutable
  before update or delete on public.lifty_onboarding_submissions
  for each row execute function private.lifty_submissions_immutable();

-- ---------------------------------------------------------------------------
-- 3. MEMBERSHIP
-- ---------------------------------------------------------------------------
-- public.workspace_memberships already exists and is exactly the minimal shape
-- P2 needs: (user_id, workspace_id) primary key, FKs to auth.users and
-- public.workspaces, RLS on, a `workspace_memberships_select` policy that lets a
-- user read their own rows, and admin-only INSERT/UPDATE/DELETE policies. It is
-- also what the dashboard workspace switcher and private.has_workspace_access()
-- read. No new table, and no `role` column: adding one would relabel 18 live
-- operator/client rows and change a table three other repos read, for zero P2
-- behaviour (there is no role taxonomy beyond owner). Ownership in P2 is
-- "the actor has a membership row", and the LIFTY-specific provenance lives in
-- lifty_onboarding_submissions.workspace_id.
--
-- public.workspaces already has a SELECT policy for authenticated
-- ("workspace access on workspaces" USING private.has_workspace_access(id)), so
-- a founder can read their own workspace row the moment the membership exists.
-- No extra workspaces policy is added here.

-- ---------------------------------------------------------------------------
-- 4. Private helpers
-- ---------------------------------------------------------------------------

-- Fixed-literal rejection. The reason code never contains draft content.
create or replace function private.lifty_reject(p_reason text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  raise exception 'lifty_draft_invalid: %', p_reason using errcode = 'PT400';
end;
$$;

-- Deterministic canonical form: objects rebuilt with keys sorted ascending,
-- arrays rebuilt in order, scalars untouched. jsonb already collapses duplicate
-- keys and whitespace on parse; this pins the remaining ordering so the digest
-- is stable across clients and Postgres versions.
create or replace function private.lifty_canonical_jsonb(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select coalesce(jsonb_object_agg(s.k, private.lifty_canonical_jsonb(p_value -> s.k)), '{}'::jsonb)
        into v_result
        from (select k from jsonb_object_keys(p_value) as k order by k) s;
    when 'array' then
      select coalesce(jsonb_agg(private.lifty_canonical_jsonb(t.e) order by t.ord), '[]'::jsonb)
        into v_result
        from jsonb_array_elements(p_value) with ordinality as t(e, ord);
    else
      v_result := p_value;
  end case;

  return v_result;
end;
$$;

-- Recursive structural guard. Returns the node count so the caller can also cap
-- total size; raises PT400 on depth / width / string-length violations.
create or replace function private.lifty_check_payload(
  p_value jsonb,
  p_depth integer,
  p_max_depth integer,
  p_max_string integer,
  p_max_items integer
)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_nodes integer := 1;
  v_key text;
  v_item jsonb;
begin
  if p_depth > p_max_depth then
    raise exception 'lifty_draft_too_large: max_depth' using errcode = 'PT413';
  end if;

  case jsonb_typeof(p_value)
    when 'object' then
      if (select count(*) from jsonb_object_keys(p_value)) > p_max_items then
        raise exception 'lifty_draft_too_large: max_object_keys' using errcode = 'PT413';
      end if;
      for v_key in select k from jsonb_object_keys(p_value) as k loop
        if length(v_key) > 200 then
          raise exception 'lifty_draft_too_large: max_key_chars' using errcode = 'PT413';
        end if;
        v_nodes := v_nodes + private.lifty_check_payload(
          p_value -> v_key, p_depth + 1, p_max_depth, p_max_string, p_max_items);
      end loop;
    when 'array' then
      if jsonb_array_length(p_value) > p_max_items then
        raise exception 'lifty_draft_too_large: max_array_items' using errcode = 'PT413';
      end if;
      for v_item in select e from jsonb_array_elements(p_value) as e loop
        v_nodes := v_nodes + private.lifty_check_payload(
          v_item, p_depth + 1, p_max_depth, p_max_string, p_max_items);
      end loop;
    when 'string' then
      if length(p_value #>> '{}') > p_max_string then
        raise exception 'lifty_draft_too_large: max_string_chars' using errcode = 'PT413';
      end if;
    else
      null;
  end case;

  return v_nodes;
end;
$$;

-- True when p is a JSON string whose trimmed length is at least p_min.
create or replace function private.lifty_is_text(p jsonb, p_min integer default 1)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and jsonb_typeof(p) = 'string'
     and length(btrim(p #>> '{}')) >= p_min;
$$;

-- Count of distinct, non-empty strings in a JSON array. -1 when p is not an array.
create or replace function private.lifty_text_array_count(p jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p is null or jsonb_typeof(p) <> 'array' then -1
    else (
      select count(distinct btrim(e #>> '{}'))::integer
        from jsonb_array_elements(p) as e
       where jsonb_typeof(e) = 'string'
         and length(btrim(e #>> '{}')) > 0
    )
  end;
$$;

-- Lowercase ascii slug, max 40 chars, never empty.
create or replace function private.lifty_slugify(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    nullif(
      btrim(
        regexp_replace(
          left(regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'), 40),
          '-+$', ''
        ),
        '-'
      ),
      ''
    ),
    'lifty-workspace'
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Draft validation — schema shape + the eight hard gates
-- ---------------------------------------------------------------------------
-- Mirrors skills/lifty-onboarding/references/onboarding-draft.schema.json and
-- the "Eight hard gates" section of its interview contract. Gate failures carry
-- reason codes gate_1 .. gate_8; the remaining writer-level requirements carry
-- their own literal codes.

create or replace function private.lifty_validate_draft(p_draft jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_top_keys constant text[] := array[
    'schema_version', 'status', 'company', 'primary_motion',
    'parked_secondary_motions', 'icp', 'personas', 'voice',
    'boundary_cases', 'negative_playback', 'research_findings',
    'founder_statement_history'
  ];
  v_company jsonb;
  v_icp jsonb;
  v_size jsonb;
  v_tooling jsonb;
  v_split jsonb;
  v_voice jsonb;
  v_motion jsonb;
  v_floor numeric;
  v_ceiling numeric;
begin
  if p_draft is null or jsonb_typeof(p_draft) <> 'object' then
    perform private.lifty_reject('draft_not_object');
  end if;

  -- Exact top-level key set. The schema is additionalProperties:false, and the
  -- exactness also stops a caller smuggling user_id / workspace_id / role keys.
  if exists (
    select 1 from jsonb_object_keys(p_draft) as k where k <> all (c_top_keys)
  ) then
    perform private.lifty_reject('unknown_top_level_key');
  end if;
  if exists (
    select 1 from unnest(c_top_keys) as k where not p_draft ? k
  ) then
    perform private.lifty_reject('missing_top_level_key');
  end if;

  if (p_draft ->> 'schema_version') is distinct from '1.0' then
    perform private.lifty_reject('schema_version');
  end if;
  if (p_draft ->> 'status') is distinct from 'ready_for_auth' then
    perform private.lifty_reject('status_not_ready_for_auth');
  end if;

  ---------------------------------------------------------------- company
  v_company := p_draft -> 'company';
  if jsonb_typeof(v_company) is distinct from 'object' then
    perform private.lifty_reject('company_not_object');
  end if;
  if not private.lifty_is_text(v_company -> 'name') then
    perform private.lifty_reject('company_name');
  end if;

  -- Gate 1: standalone company description.
  if not private.lifty_is_text(v_company -> 'description', 20) then
    perform private.lifty_reject('gate_1_company_description');
  end if;

  -- Gate 2: three named example companies.
  if private.lifty_text_array_count(v_company -> 'example_companies') < 3 then
    perform private.lifty_reject('gate_2_example_companies');
  end if;

  ---------------------------------------------------------------- icp
  v_icp := p_draft -> 'icp';
  if jsonb_typeof(v_icp) is distinct from 'object' then
    perform private.lifty_reject('icp_not_object');
  end if;

  -- Gate 3: numeric size floor plus the founder's unit.
  v_size := v_icp -> 'size';
  if jsonb_typeof(v_size) is distinct from 'object'
     or jsonb_typeof(v_size -> 'floor') is distinct from 'number'
     or not private.lifty_is_text(v_size -> 'unit')
  then
    perform private.lifty_reject('gate_3_numeric_size_floor');
  end if;
  v_floor := (v_size ->> 'floor')::numeric;
  if v_floor <= 0 then
    perform private.lifty_reject('gate_3_numeric_size_floor');
  end if;
  if not (v_size ? 'ceiling')
     or jsonb_typeof(v_size -> 'ceiling') not in ('number', 'null')
  then
    perform private.lifty_reject('gate_3_size_ceiling');
  end if;
  if jsonb_typeof(v_size -> 'ceiling') = 'number' then
    v_ceiling := (v_size ->> 'ceiling')::numeric;
    if v_ceiling <= 0 or v_ceiling < v_floor then
      perform private.lifty_reject('gate_3_size_ceiling');
    end if;
  end if;
  if exists (
    select 1 from jsonb_object_keys(v_size) as k
    where k <> all (array['floor', 'ceiling', 'unit'])
  ) then
    perform private.lifty_reject('gate_3_size_extra_key');
  end if;

  -- Gate 4: at least one hard disqualifier.
  if private.lifty_text_array_count(v_icp -> 'hard_disqualifiers') < 1 then
    perform private.lifty_reject('gate_4_hard_disqualifier');
  end if;

  -- Industries in and out (the writer treats an empty exclusion set as incomplete).
  if private.lifty_text_array_count(v_icp -> 'industries_in') < 1 then
    perform private.lifty_reject('icp_industries_in');
  end if;
  if private.lifty_text_array_count(v_icp -> 'industries_out') < 1 then
    perform private.lifty_reject('icp_industries_out');
  end if;

  -- Gate 5: at least one publicly observable structural buy signal.
  if jsonb_typeof(v_icp -> 'structural_buy_signals') is distinct from 'array'
     or not exists (
       select 1
         from jsonb_array_elements(v_icp -> 'structural_buy_signals') as e
        where jsonb_typeof(e) = 'object'
          and private.lifty_is_text(e -> 'signal')
          and private.lifty_is_text(e -> 'observable_via')
     )
  then
    perform private.lifty_reject('gate_5_structural_buy_signal');
  end if;

  -- Gate 7: explicit founder judgment of tooling.
  v_tooling := v_icp -> 'tooling_judgment';
  if jsonb_typeof(v_tooling) is distinct from 'object'
     or (v_tooling ->> 'classification') is null
     or (v_tooling ->> 'classification') not in ('signal', 'disqualifier', 'mixed')
     or not private.lifty_is_text(v_tooling -> 'rationale')
  then
    perform private.lifty_reject('gate_7_tooling_judgment');
  end if;

  -- operating_state_split is object-or-null; when present it must be split, not merged.
  if not (v_icp ? 'operating_state_split') then
    perform private.lifty_reject('icp_operating_state_split');
  end if;
  v_split := v_icp -> 'operating_state_split';
  if jsonb_typeof(v_split) = 'object' then
    if not private.lifty_is_text(v_split -> 'priority')
       or jsonb_typeof(v_split -> 'states') is distinct from 'array'
       or jsonb_array_length(v_split -> 'states') < 2
       or exists (
         select 1
           from jsonb_array_elements(v_split -> 'states') as e
          where jsonb_typeof(e) is distinct from 'object'
             or not private.lifty_is_text(e -> 'name')
             or not private.lifty_is_text(e -> 'fit')
       )
    then
      perform private.lifty_reject('icp_operating_state_split');
    end if;
  elsif jsonb_typeof(v_split) is distinct from 'null' then
    perform private.lifty_reject('icp_operating_state_split');
  end if;

  ---------------------------------------------------------------- personas
  if jsonb_typeof(p_draft -> 'personas') is distinct from 'array'
     or jsonb_array_length(p_draft -> 'personas') < 1
  then
    perform private.lifty_reject('personas_not_array');
  end if;
  -- Every persona is well formed ...
  if exists (
    select 1
      from jsonb_array_elements(p_draft -> 'personas') as e
     where jsonb_typeof(e) is distinct from 'object'
        or not private.lifty_is_text(e -> 'name')
        or (e ->> 'role') is null
        or (e ->> 'role') not in ('decision_maker', 'influencer')
        or not private.lifty_is_text(e -> 'tell')
  ) then
    perform private.lifty_reject('persona_shape');
  end if;
  -- ... and Gate 6: at least one persona carries three or more titles.
  if not exists (
    select 1
      from jsonb_array_elements(p_draft -> 'personas') as e
     where private.lifty_text_array_count(e -> 'titles') >= 3
  ) then
    perform private.lifty_reject('gate_6_persona_titles');
  end if;

  ---------------------------------------------------------------- voice
  v_voice := p_draft -> 'voice';
  if jsonb_typeof(v_voice) is distinct from 'object' then
    perform private.lifty_reject('voice_not_object');
  end if;
  if private.lifty_text_array_count(v_voice -> 'adjectives') < 1 then
    perform private.lifty_reject('voice_adjectives');
  end if;

  -- Gate 8: at least one tone forbidden move.
  if private.lifty_text_array_count(v_voice -> 'forbidden_moves') < 1 then
    perform private.lifty_reject('gate_8_forbidden_move');
  end if;

  if not private.lifty_is_text(v_voice -> 'sender_intent') then
    perform private.lifty_reject('voice_sender_intent');
  end if;
  if not private.lifty_is_text(v_voice -> 'cta') then
    perform private.lifty_reject('voice_cta');
  end if;

  ---------------------------------------------------------------- motions
  v_motion := p_draft -> 'primary_motion';
  if jsonb_typeof(v_motion) is distinct from 'object'
     or not private.lifty_is_text(v_motion -> 'name')
     or not private.lifty_is_text(v_motion -> 'outcome')
  then
    perform private.lifty_reject('primary_motion');
  end if;

  if jsonb_typeof(p_draft -> 'parked_secondary_motions') is distinct from 'array'
     or exists (
       select 1
         from jsonb_array_elements(p_draft -> 'parked_secondary_motions') as e
        where jsonb_typeof(e) is distinct from 'object'
           or not private.lifty_is_text(e -> 'name')
           or (e ->> 'status') is distinct from 'parked'
     )
  then
    perform private.lifty_reject('parked_secondary_motions');
  end if;

  ---------------------------------------------------------------- boundary cases
  if jsonb_typeof(p_draft -> 'boundary_cases') is distinct from 'array'
     or jsonb_array_length(p_draft -> 'boundary_cases') < 2
     or exists (
       select 1
         from jsonb_array_elements(p_draft -> 'boundary_cases') as e
        where jsonb_typeof(e) is distinct from 'object'
           or not private.lifty_is_text(e -> 'rule_under_test')
           or (e -> 'all_other_hard_rules_held') is distinct from 'true'::jsonb
           or not private.lifty_is_text(e -> 'scenario')
           or (e ->> 'decision') is null
           or (e ->> 'decision') not in ('A', 'B', 'pass')
           or not private.lifty_is_text(e -> 'reason')
     )
  then
    perform private.lifty_reject('boundary_cases');
  end if;

  ---------------------------------------------------------------- negative playback
  if jsonb_typeof(p_draft -> 'negative_playback') is distinct from 'array'
     or jsonb_array_length(p_draft -> 'negative_playback') < 1
     or exists (
       select 1
         from jsonb_array_elements(p_draft -> 'negative_playback') as e
        where jsonb_typeof(e) is distinct from 'object'
           or not private.lifty_is_text(e -> 'omission_or_weak_signal')
           or not private.lifty_is_text(e -> 'founder_response')
           or not private.lifty_is_text(e -> 'result')
     )
  then
    perform private.lifty_reject('negative_playback');
  end if;

  ---------------------------------------------------------------- research findings
  if jsonb_typeof(p_draft -> 'research_findings') is distinct from 'array'
     or exists (
       select 1
         from jsonb_array_elements(p_draft -> 'research_findings') as e
        where jsonb_typeof(e) is distinct from 'object'
           or not private.lifty_is_text(e -> 'field')
           or not (e ? 'value')
           or not private.lifty_is_text(e -> 'source')
           or (e ->> 'state') is null
           or (e ->> 'state') not in ('inferred', 'founder_confirmed', 'founder_corrected')
           or jsonb_typeof(e -> 'used_in_configuration') is distinct from 'boolean'
           or not (e ? 'founder_confirmation')
           or jsonb_typeof(e -> 'founder_confirmation') not in ('string', 'null')
     )
  then
    perform private.lifty_reject('research_findings');
  end if;

  ---------------------------------------------------------------- statement history
  if jsonb_typeof(p_draft -> 'founder_statement_history') is distinct from 'array'
     or exists (
       select 1
         from jsonb_array_elements(p_draft -> 'founder_statement_history') as e
        where jsonb_typeof(e) is distinct from 'object'
           or jsonb_typeof(e -> 'sequence') is distinct from 'number'
           or (e ->> 'sequence')::numeric < 1
           or (e ->> 'sequence')::numeric <> trunc((e ->> 'sequence')::numeric)
           or not private.lifty_is_text(e -> 'field')
           or not (e ? 'value')
     )
  then
    perform private.lifty_reject('founder_statement_history');
  end if;
end;
$$;

comment on function private.lifty_validate_draft(jsonb) is
  'LIF-607: server-side enforcement of the LIFTY onboarding draft schema (version 1.0) and the eight hard configuration gates. Raises PT400 with a fixed reason code; never echoes draft content.';

-- Private helpers are internal. anon and authenticated hold USAGE on the
-- private schema (existing RLS policies call private.is_admin), so EXECUTE has
-- to be revoked explicitly.
revoke execute on function private.lifty_reject(text) from public, anon, authenticated;
revoke execute on function private.lifty_canonical_jsonb(jsonb) from public, anon, authenticated;
revoke execute on function private.lifty_check_payload(jsonb, integer, integer, integer, integer) from public, anon, authenticated;
revoke execute on function private.lifty_is_text(jsonb, integer) from public, anon, authenticated;
revoke execute on function private.lifty_text_array_count(jsonb) from public, anon, authenticated;
revoke execute on function private.lifty_slugify(text) from public, anon, authenticated;
revoke execute on function private.lifty_validate_draft(jsonb) from public, anon, authenticated;
revoke execute on function private.lifty_submissions_immutable() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. public.get_lifty_workspace_status()
-- ---------------------------------------------------------------------------

create or replace function public.get_lifty_workspace_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_workspace_id uuid;
  v_name text;
  v_is_active boolean;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'unauthenticated' using errcode = 'PT401';
  end if;

  -- One workspace per LIFTY founder. LIFT operator accounts hold many
  -- memberships, so the pick is made deterministic (oldest membership, then
  -- workspace id) rather than arbitrary.
  select w.id, w.name, w.is_active
    into v_workspace_id, v_name, v_is_active
    from public.workspace_memberships m
    join public.workspaces w on w.id = m.workspace_id
   where m.user_id = v_actor
   order by m.created_at asc, w.id asc
   limit 1;

  if not found then
    return jsonb_build_object(
      'state', 'needs_workspace',
      'workspace', null::jsonb,
      'next_action', 'provision_workspace'
    );
  end if;

  return jsonb_build_object(
    'state', case when v_is_active then 'ready_for_connections' else 'suspended' end,
    'workspace', jsonb_build_object(
      'workspace_ref', v_workspace_id::text,
      'name', v_name
    ),
    'next_action', null::text
  );
end;
$$;

comment on function public.get_lifty_workspace_status() is
  'LIF-607: LIFTY actor state probe. Returns {state, workspace, next_action}; state is needs_workspace | ready_for_connections | suspended and next_action is provision_workspace only in needs_workspace. Actor comes from auth.uid() alone.';

alter function public.get_lifty_workspace_status() owner to postgres;

-- Supabase default privileges grant EXECUTE on new public functions to anon,
-- authenticated and service_role, and REVOKE ... FROM PUBLIC does not strip a
-- grant held directly by anon. Both roles must be named.
revoke execute on function public.get_lifty_workspace_status() from public, anon;
grant execute on function public.get_lifty_workspace_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. public.provision_lifty_workspace(draft jsonb)
-- ---------------------------------------------------------------------------

create or replace function public.provision_lifty_workspace(draft jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_max_bytes    constant integer := 131072;
  c_max_depth    constant integer := 12;
  c_max_nodes    constant integer := 5000;
  c_max_string   constant integer := 4000;
  c_max_items    constant integer := 200;
  c_max_name     constant integer := 200;
  c_schema_ver   constant text    := '1.0';
  c_lock_class   constant integer := 607;

  v_actor uuid;
  v_canonical jsonb;
  v_digest text;
  v_nodes integer;
  v_workspace_id uuid;
  v_workspace_name text;
  v_slug_base text;
  v_slug text;
begin
  -- Actor comes from the JWT and nowhere else. The signature deliberately takes
  -- no user or tenant identifier.
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'unauthenticated' using errcode = 'PT401';
  end if;

  ------------------------------------------------------------------ hardening
  if draft is null or jsonb_typeof(draft) <> 'object' then
    perform private.lifty_reject('draft_not_object');
  end if;

  if octet_length(draft::text) > c_max_bytes then
    raise exception 'lifty_draft_too_large: max_bytes' using errcode = 'PT413';
  end if;

  v_nodes := private.lifty_check_payload(draft, 1, c_max_depth, c_max_string, c_max_items);
  if v_nodes > c_max_nodes then
    raise exception 'lifty_draft_too_large: max_nodes' using errcode = 'PT413';
  end if;

  ------------------------------------------------------------------ validation
  perform private.lifty_validate_draft(draft);

  ------------------------------------------------------------------ identity
  v_canonical := private.lifty_canonical_jsonb(draft);
  v_digest := 'sha256:' || encode(
    extensions.digest(convert_to(v_canonical::text, 'UTF8'), 'sha256'), 'hex');

  -- Serialize every provisioning attempt by this actor. Without it two
  -- *different* drafts submitted concurrently would both pass the
  -- already-has-a-workspace check and create two workspaces; the unique index
  -- only catches concurrent *identical* drafts.
  perform pg_advisory_xact_lock(c_lock_class, hashtext(v_actor::text));

  ------------------------------------------------------------------ idempotency
  select s.workspace_id, w.name
    into v_workspace_id, v_workspace_name
    from public.lifty_onboarding_submissions s
    join public.workspaces w on w.id = s.workspace_id
   where s.user_id = v_actor
     and s.draft_digest = v_digest
   limit 1;

  if found then
    return jsonb_build_object(
      'state', 'ready_for_connections',
      'workspace', jsonb_build_object(
        'workspace_ref', v_workspace_id::text,
        'name', v_workspace_name
      ),
      'draft_digest', v_digest
    );
  end if;

  -- Same actor, different draft, workspace already exists.
  if exists (
    select 1 from public.workspace_memberships m where m.user_id = v_actor
  ) then
    raise exception 'workspace_already_exists' using errcode = 'PT409';
  end if;

  ------------------------------------------------------------------ slug
  v_workspace_name := left(btrim(draft #>> '{company,name}'), c_max_name);
  v_slug_base := private.lifty_slugify(v_workspace_name);

  -- Two different actors can derive the same base slug; serialize on it so the
  -- free/taken check below is not a race.
  perform pg_advisory_xact_lock(c_lock_class, hashtext('lifty_slug:' || v_slug_base));

  v_slug := v_slug_base;
  if exists (select 1 from public.workspaces w where w.slug = v_slug) then
    v_slug := left(v_slug_base, 31) || '-' || left(
      encode(extensions.digest(convert_to(v_actor::text, 'UTF8'), 'sha256'), 'hex'), 8);
  end if;

  ------------------------------------------------------------------ create
  -- One transaction: workspace (safe at rest) + owner membership + submission.
  -- No external calls, no http, no pg_net, nothing that can send.
  begin
    insert into public.workspaces (
      name,
      slug,
      description,
      outreach_context,
      tier,
      is_active,
      pipeline_active,
      auto_reply_enabled,
      first_dm_review_enabled,
      linkedin_review_enabled,
      email_review_enabled,
      allow_hubspot_provisioning,
      apollo_phone_reveal_enabled
    ) values (
      v_workspace_name,
      v_slug,
      btrim(draft #>> '{company,description}'),
      jsonb_build_object(
        'identity',   btrim(draft #>> '{voice,sender_intent}'),
        'value_prop', btrim(draft #>> '{primary_motion,outcome}'),
        'cta',        btrim(draft #>> '{voice,cta}')
      ),
      'tier_1',   -- enrichment + CRM sync; tier_2 (outreach) is a service-plan decision
      true,       -- is_active: the workspace exists and is visible
      false,      -- pipeline_active: explicit; the column default is true
      false,      -- auto_reply_enabled
      true,       -- first_dm_review_enabled
      true,       -- linkedin_review_enabled (kept in sync by trg_sync_workspaces_linkedin_review_enabled)
      true,       -- email_review_enabled
      false,      -- allow_hubspot_provisioning
      false       -- apollo_phone_reveal_enabled
    )
    returning id into v_workspace_id;
    -- Everything else is left at its correct-for-inert default:
    -- daily_discovery_target=10, crm_provider=null, hubspot_portal_id=null,
    -- review_sample_rate=100, linkedin_only_leads_enabled=false,
    -- open_deal_suppression_enabled=false, crm_activity_gate_enabled=false,
    -- compose modes = 'generate'. No workspace_channels, workspace_senders,
    -- workspace_integrations, icp_configs or agent_prompts rows are created —
    -- their absence is the operative can't-send guarantee.

    insert into public.workspace_memberships (user_id, workspace_id)
    values (v_actor, v_workspace_id);

    insert into public.lifty_onboarding_submissions (
      user_id, workspace_id, schema_version, normalized_draft, draft_digest, import_status
    ) values (
      v_actor, v_workspace_id, c_schema_ver, v_canonical, v_digest, 'pending'
    );
  exception when unique_violation then
    -- The block is a subtransaction, so the workspace insert above is rolled
    -- back here: a concurrent identical call committed first and exactly one
    -- workspace survives. Return that winner's result.
    select s.workspace_id, w.name
      into v_workspace_id, v_workspace_name
      from public.lifty_onboarding_submissions s
      join public.workspaces w on w.id = s.workspace_id
     where s.user_id = v_actor
       and s.draft_digest = v_digest
     limit 1;

    if not found then
      raise exception 'provisioning_conflict' using errcode = 'PT409';
    end if;
  end;

  return jsonb_build_object(
    'state', 'ready_for_connections',
    'workspace', jsonb_build_object(
      'workspace_ref', v_workspace_id::text,
      'name', v_workspace_name
    ),
    'draft_digest', v_digest
  );
end;
$$;

comment on function public.provision_lifty_workspace(jsonb) is
  'LIF-607: the single LIFTY provisioning write path. Validates the v1.0 onboarding draft and the eight hard gates, canonicalises it, and in one transaction creates a safe-at-rest workspace (pipeline off, outreach off, every review gate on), the owner membership, and an append-only submission receipt. Idempotent on (auth.uid(), sha256 digest); a different draft for an actor who already has a workspace raises workspace_already_exists.';

alter function public.provision_lifty_workspace(jsonb) owner to postgres;

revoke execute on function public.provision_lifty_workspace(jsonb) from public, anon;
grant execute on function public.provision_lifty_workspace(jsonb) to authenticated;
