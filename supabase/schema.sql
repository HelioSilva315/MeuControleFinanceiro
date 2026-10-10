-- =====================================================================
--  Nosso Caixa — Backend (Supabase) — schema v1
--  Execute este arquivo no SQL Editor do projeto Supabase
--  (ou rode: supabase db push / psql -f schema.sql).
--
--  Modelo de dados
--    auth.users (Supabase)
--      └── profiles            (1 linha por usuário)
--      └── households          (o "casal")
--             ├── household_members   (quem participa)
--             ├── subscriptions       (Stripe / Google Play -> premium)
--             └── cloud_backups       (blob CRIPTOGRAFADO no cliente)
--
--  O servidor guarda o backup SEMPRE cifrado (ponta-a-ponta).
--  Quem NÃO é premium continua 100% offline; a nuvem é o diferencial pago.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
--  Utilitários
-- ---------------------------------------------------------------------
-- IDs das famílias (households) do usuário logado.
-- SECURITY DEFINER: roda como dono da função, ignorando RLS,
-- evitando recursão nas próprias políticas.
create or replace function public.my_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id
  from public.household_members
  where user_id = auth.uid();
$$;

-- Household "ativo" (o mais antigo) do usuário.
create or replace function public.my_household()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id
  from public.household_members
  where user_id = auth.uid()
  order by created_at asc
  limit 1;
$$;

-- ---------------------------------------------------------------------
--  Perfis
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now()
);

-- Cria o perfil automaticamente após o cadastro.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
--  Casal (household)
-- ---------------------------------------------------------------------
create table if not exists public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'Nosso Caixa',
  owner_id   uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- Ao criar o household, o dono vira membro automaticamente.
create or replace function public.handle_new_household()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.household_members (household_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_household_created on public.households;
create trigger on_household_created
  after insert on public.households
  for each row execute function public.handle_new_household();

-- ---------------------------------------------------------------------
--  Assinaturas (Stripe = web, Google Play = Android)
--  Escritas acontecem SÓ pelas Edge Functions (service_role).
-- ---------------------------------------------------------------------
create table if not exists public.subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references public.households(id) on delete cascade,
  provider           text not null check (provider in ('stripe', 'google')),
  store              text not null default 'web' check (store in ('web', 'play')),
  external_id        text not null,                 -- stripe subscription id | purchaseToken
  product_id         text,
  price_id           text,
  status             text not null default 'incomplete',
  current_period_end timestamptz,
  raw                jsonb,
  updated_at         timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (provider, external_id)
);

create index if not exists subscriptions_household_idx on public.subscriptions (household_id);

-- Situação premium de um household.
create or replace function public.is_premium(p_household uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.household_id = p_household
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;

-- Situação premium do usuário logado.
create or replace function public.i_am_premium()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.is_premium(public.my_household()), false);
$$;

-- ---------------------------------------------------------------------
--  Backup criptografado (ponta-a-ponta)
-- ---------------------------------------------------------------------
create table if not exists public.cloud_backups (
  household_id uuid primary key references public.households(id) on delete cascade,
  ciphertext   text not null,          -- payload cifrado (AES-GCM) no app
  rev          bigint not null default 1,
  updated_at   timestamptz not null default now()
);

-- =====================================================================
--  Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.households         enable row level security;
alter table public.household_members  enable row level security;
alter table public.subscriptions      enable row level security;
alter table public.cloud_backups      enable row level security;

-- profiles
drop policy if exists "profiles self read"   on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self read"   on public.profiles for select using (id = auth.uid());
create policy "profiles self update" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- households
drop policy if exists "households read mine"    on public.households;
drop policy if exists "households create own"   on public.households;
drop policy if exists "households owner update" on public.households;
create policy "households read mine" on public.households for select
  using (id in (select public.my_household_ids()));
create policy "households create own" on public.households for insert
  with check (owner_id = auth.uid());
create policy "households owner update" on public.households for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- household_members
drop policy if exists "members read mine"        on public.household_members;
drop policy if exists "members insert by owner"  on public.household_members;
drop policy if exists "members delete by owner"  on public.household_members;
create policy "members read mine" on public.household_members for select
  using (household_id in (select public.my_household_ids()));
create policy "members insert by owner" on public.household_members for insert
  with check (household_id in (select id from public.households where owner_id = auth.uid()));
create policy "members delete by owner" on public.household_members for delete
  using (household_id in (select id from public.households where owner_id = auth.uid()));

-- subscriptions
drop policy if exists "subs read mine" on public.subscriptions;
create policy "subs read mine" on public.subscriptions for select
  using (household_id in (select public.my_household_ids()));

-- cloud_backups
drop policy if exists "backups read"           on public.cloud_backups;
drop policy if exists "backups insert premium" on public.cloud_backups;
drop policy if exists "backups update premium" on public.cloud_backups;
create policy "backups read" on public.cloud_backups for select
  using (household_id in (select public.my_household_ids()));
create policy "backups insert premium" on public.cloud_backups for insert
  with check (household_id in (select public.my_household_ids()) and public.i_am_premium());
create policy "backups update premium" on public.cloud_backups for update
  using (household_id in (select public.my_household_ids()) and public.i_am_premium())
  with check (household_id in (select public.my_household_ids()) and public.i_am_premium());

-- ---------------------------------------------------------------------
--  Permissões (RLS continua decidindo o que cada linha permite)
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.profiles          to authenticated;
grant select, insert, update, delete on public.households        to authenticated;
grant select, insert, update, delete on public.household_members to authenticated;
grant select                         on public.subscriptions     to authenticated;
grant select, insert, update         on public.cloud_backups      to authenticated;

grant execute on function public.my_household_ids() to authenticated;
grant execute on function public.my_household()     to authenticated;
grant execute on function public.is_premium(uuid)   to authenticated;
grant execute on function public.i_am_premium()     to authenticated;
