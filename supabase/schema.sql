-- ワンタッチ作業報告（worklog）のテーブル
-- ひびログと同じ Supabase プロジェクトに置くので、名前は wl_ で始める
-- DROP を使わない（MCP から流すと拒否されるため）。何度流しても同じ結果になるように書く

create extension if not exists pgcrypto;

-- 会社（チーム）
create table if not exists public.wl_orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

-- メンバー（1人は1つの会社だけに入る）
create table if not exists public.wl_members (
  org_id uuid not null references public.wl_orgs(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  display_name text not null check (char_length(display_name) between 1 and 40),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- 現場・作業の候補
create table if not exists public.wl_sites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.wl_orgs(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists wl_sites_org on public.wl_sites(org_id);

-- 開始・終了の記録（あとから書き換えられない）
create table if not exists public.wl_punches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.wl_orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('start', 'end')),
  site_id uuid references public.wl_sites(id) on delete set null,
  site_name text,
  display_name text not null,
  lat double precision,
  lng double precision,
  accuracy double precision,
  geo_error text,
  photo_path text,
  created_at timestamptz not null default now()
);
create index if not exists wl_punches_org_time on public.wl_punches(org_id, created_at desc);
create index if not exists wl_punches_user_time on public.wl_punches(user_id, created_at desc);

-- 通知を受け取る端末
create table if not exists public.wl_push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists wl_push_subs_user on public.wl_push_subs(user_id);

-- サーバーだけが読む設定（通知用の鍵）。ポリシーなし = アプリからは読めない
create table if not exists public.wl_secrets (
  name text primary key,
  value text not null
);

alter table public.wl_orgs enable row level security;
alter table public.wl_members enable row level security;
alter table public.wl_sites enable row level security;
alter table public.wl_punches enable row level security;
alter table public.wl_push_subs enable row level security;
alter table public.wl_secrets enable row level security;

-- ---------- 判定用の関数 ----------
create or replace function public.wl_my_org() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.wl_members where user_id = auth.uid() and active
$$;

create or replace function public.wl_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.wl_members where user_id = auth.uid() and active and role = 'admin')
$$;

-- ---------- ポリシー ----------
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'wl_orgs' and policyname = 'wl_orgs_read') then
    create policy wl_orgs_read on public.wl_orgs for select to authenticated using (id = public.wl_my_org());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'wl_orgs' and policyname = 'wl_orgs_admin_update') then
    create policy wl_orgs_admin_update on public.wl_orgs for update to authenticated
      using (id = public.wl_my_org() and public.wl_is_admin()) with check (id = public.wl_my_org());
  end if;

  if not exists (select 1 from pg_policies where tablename = 'wl_members' and policyname = 'wl_members_read') then
    create policy wl_members_read on public.wl_members for select to authenticated
      using (user_id = auth.uid() or (org_id = public.wl_my_org() and public.wl_is_admin()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'wl_members' and policyname = 'wl_members_admin_update') then
    create policy wl_members_admin_update on public.wl_members for update to authenticated
      using (org_id = public.wl_my_org() and public.wl_is_admin()) with check (org_id = public.wl_my_org());
  end if;

  if not exists (select 1 from pg_policies where tablename = 'wl_sites' and policyname = 'wl_sites_read') then
    create policy wl_sites_read on public.wl_sites for select to authenticated using (org_id = public.wl_my_org());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'wl_sites' and policyname = 'wl_sites_admin_insert') then
    create policy wl_sites_admin_insert on public.wl_sites for insert to authenticated
      with check (org_id = public.wl_my_org() and public.wl_is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'wl_sites' and policyname = 'wl_sites_admin_update') then
    create policy wl_sites_admin_update on public.wl_sites for update to authenticated
      using (org_id = public.wl_my_org() and public.wl_is_admin()) with check (org_id = public.wl_my_org());
  end if;

  if not exists (select 1 from pg_policies where tablename = 'wl_punches' and policyname = 'wl_punches_read') then
    create policy wl_punches_read on public.wl_punches for select to authenticated
      using (user_id = auth.uid() or (org_id = public.wl_my_org() and public.wl_is_admin()));
  end if;

  if not exists (select 1 from pg_policies where tablename = 'wl_push_subs' and policyname = 'wl_push_subs_own') then
    create policy wl_push_subs_own on public.wl_push_subs for all to authenticated
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- ---------- 打刻（名前・会社・時刻はサーバー側で決める） ----------
create or replace function public.wl_punch(
  p_kind text, p_site uuid, p_lat double precision, p_lng double precision,
  p_accuracy double precision, p_geo_error text, p_photo text
) returns public.wl_punches
language plpgsql security definer set search_path = public as $$
declare m public.wl_members; s public.wl_sites; r public.wl_punches;
begin
  select * into m from public.wl_members where user_id = auth.uid() and active;
  if m.user_id is null then raise exception 'not_member'; end if;
  if p_kind not in ('start', 'end') then raise exception 'bad_kind'; end if;
  if p_site is not null then
    select * into s from public.wl_sites where id = p_site and org_id = m.org_id;
    if s.id is null then raise exception 'bad_site'; end if;
  end if;
  -- 写真は自分のフォルダのものだけ
  if p_photo is not null and p_photo not like m.org_id || '/' || m.user_id || '/%' then
    raise exception 'bad_photo';
  end if;
  insert into public.wl_punches (org_id, user_id, kind, site_id, site_name, display_name,
    lat, lng, accuracy, geo_error, photo_path)
  values (m.org_id, m.user_id, p_kind, s.id, s.name, m.display_name,
    p_lat, p_lng, p_accuracy, left(p_geo_error, 200), p_photo)
  returning * into r;
  return r;
end $$;

-- ---------- 会社を作る / 参加する ----------
create or replace function public.wl_new_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 8)
$$;

create or replace function public.wl_create_org(p_org_name text, p_display_name text) returns public.wl_orgs
language plpgsql security definer set search_path = public as $$
declare o public.wl_orgs;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if exists (select 1 from public.wl_members where user_id = auth.uid()) then raise exception 'already_member'; end if;
  insert into public.wl_orgs (name, invite_code, created_by)
  values (trim(p_org_name), public.wl_new_code(), auth.uid()) returning * into o;
  insert into public.wl_members (org_id, user_id, role, display_name)
  values (o.id, auth.uid(), 'admin', trim(p_display_name));
  return o;
end $$;

create or replace function public.wl_join_org(p_code text, p_display_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare o public.wl_orgs;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if exists (select 1 from public.wl_members where user_id = auth.uid()) then raise exception 'already_member'; end if;
  select * into o from public.wl_orgs where invite_code = upper(replace(trim(p_code), ' ', ''));
  if o.id is null then raise exception 'bad_code'; end if;
  insert into public.wl_members (org_id, user_id, role, display_name)
  values (o.id, auth.uid(), 'staff', trim(p_display_name));
  return o.id;
end $$;

create or replace function public.wl_rotate_code() returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.wl_is_admin() then raise exception 'not_admin'; end if;
  update public.wl_orgs set invite_code = public.wl_new_code() where id = public.wl_my_org() returning invite_code into c;
  return c;
end $$;

-- 自分の名前を変える（過去の記録の名前はそのまま残る）
create or replace function public.wl_set_my_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.wl_members set display_name = trim(p_name) where user_id = auth.uid();
end $$;

-- 最後の管理者は外せないようにする
create or replace function public.wl_guard_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and (new.role <> 'admin' or not new.active) and not exists (
    select 1 from public.wl_members where org_id = old.org_id and role = 'admin' and active and user_id <> old.user_id
  ) then raise exception 'last_admin'; end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'wl_guard_admin') then
    create trigger wl_guard_admin before update on public.wl_members
      for each row execute function public.wl_guard_admin();
  end if;
end $$;

revoke all on function public.wl_punch(text, uuid, double precision, double precision, double precision, text, text) from public, anon;
revoke all on function public.wl_create_org(text, text) from public, anon;
revoke all on function public.wl_join_org(text, text) from public, anon;
revoke all on function public.wl_rotate_code() from public, anon;
revoke all on function public.wl_set_my_name(text) from public, anon;
revoke all on function public.wl_new_code() from public, anon;
grant execute on function public.wl_punch(text, uuid, double precision, double precision, double precision, text, text) to authenticated;
grant execute on function public.wl_create_org(text, text) to authenticated;
grant execute on function public.wl_join_org(text, text) to authenticated;
grant execute on function public.wl_rotate_code() to authenticated;
grant execute on function public.wl_set_my_name(text) to authenticated;

-- このプロジェクトは自動で権限が付かないので明示する
grant select, update on public.wl_orgs to authenticated;
grant select, update on public.wl_members to authenticated;
grant select, insert, update on public.wl_sites to authenticated;
grant select on public.wl_punches to authenticated;
grant select, insert, update, delete on public.wl_push_subs to authenticated;
grant all on public.wl_orgs, public.wl_members, public.wl_sites, public.wl_punches,
  public.wl_push_subs, public.wl_secrets to service_role;

-- ---------- 写真の置き場所（非公開） ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wl-photos', 'wl-photos', false, 3145728, array['image/jpeg'])
on conflict (id) do nothing;

do $$ begin
  -- アップロード: 自分の会社/自分のフォルダだけ
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'wl_photos_insert') then
    create policy wl_photos_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'wl-photos'
        and (storage.foldername(name))[1] = public.wl_my_org()::text
        and (storage.foldername(name))[2] = auth.uid()::text);
  end if;
  -- 見る: 自分の写真、または管理者なら会社の写真
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'wl_photos_read') then
    create policy wl_photos_read on storage.objects for select to authenticated
      using (bucket_id = 'wl-photos'
        and (storage.foldername(name))[1] = public.wl_my_org()::text
        and ((storage.foldername(name))[2] = auth.uid()::text or public.wl_is_admin()));
  end if;
end $$;

-- 2026-11-24: スタッフは自分の行だけ、管理者は会社全員を見られる（すでに作った環境はこれで直す）
alter policy wl_members_read on public.wl_members
  using (user_id = auth.uid() or (org_id = public.wl_my_org() and public.wl_is_admin()));
