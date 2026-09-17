-- Sillon : à exécuter une fois dans Supabase > SQL Editor.
-- Crée la table de bibliothèque, le stockage des fichiers et les règles d'accès :
-- chaque compte ne voit et ne modifie que ses propres données.

create table if not exists public.library (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('track', 'playlist')),
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);

create index if not exists library_user_updated_idx on public.library (user_id, updated_at);

alter table public.library enable row level security;

drop policy if exists "library: lecture" on public.library;
drop policy if exists "library: ajout" on public.library;
drop policy if exists "library: modification" on public.library;
drop policy if exists "library: suppression" on public.library;

create policy "library: lecture" on public.library
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "library: ajout" on public.library
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "library: modification" on public.library
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "library: suppression" on public.library
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Horodatage fixé par le serveur (évite les écarts d'horloge entre appareils)
create or replace function public.library_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists library_touch on public.library;
create trigger library_touch before insert or update on public.library
  for each row execute function public.library_touch();

-- Fichiers audio et pochettes : bucket privé, un dossier par compte
insert into storage.buckets (id, name, public, file_size_limit)
values ('sillon', 'sillon', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "sillon: lecture" on storage.objects;
drop policy if exists "sillon: ajout" on storage.objects;
drop policy if exists "sillon: modification" on storage.objects;
drop policy if exists "sillon: suppression" on storage.objects;

create policy "sillon: lecture" on storage.objects
  for select to authenticated
  using (bucket_id = 'sillon' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "sillon: ajout" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sillon' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "sillon: modification" on storage.objects
  for update to authenticated
  using (bucket_id = 'sillon' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'sillon' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "sillon: suppression" on storage.objects
  for delete to authenticated
  using (bucket_id = 'sillon' and (storage.foldername(name))[1] = (select auth.uid())::text);
