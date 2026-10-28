-- Fusain : tables et règles d'accès.
-- À exécuter UNE FOIS, à la main, dans l'éditeur SQL du projet Supabase existant (jamais de nouveau projet sans l'accord de Jérôme).
-- Tables préfixées par le nom de l'app : fusain_.

create table if not exists public.fusain_projects (
  id         uuid primary key,
  owner      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null default '',
  data       jsonb not null,                       -- description du projet : pages, cases, calques (sans pixels), bulles
  deleted    boolean not null default false,       -- corbeille
  updated_at timestamptz not null default now()
);

create index if not exists fusain_projects_owner_idx on public.fusain_projects (owner, updated_at desc);

alter table public.fusain_projects enable row level security;

create policy "fusain_projects : lecture par le propriétaire" on public.fusain_projects
  for select to authenticated using (owner = auth.uid());
create policy "fusain_projects : ajout par le propriétaire" on public.fusain_projects
  for insert to authenticated with check (owner = auth.uid());
create policy "fusain_projects : mise à jour par le propriétaire" on public.fusain_projects
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "fusain_projects : suppression par le propriétaire" on public.fusain_projects
  for delete to authenticated using (owner = auth.uid());

-- Les calques sont des images PNG dans le bucket privé « fusain » : <uid>/<projet>/<calque>.png
insert into storage.buckets (id, name, public) values ('fusain', 'fusain', false)
  on conflict (id) do nothing;

create policy "fusain : images lisibles par le propriétaire" on storage.objects
  for select to authenticated using (bucket_id = 'fusain' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fusain : images ajoutées par le propriétaire" on storage.objects
  for insert to authenticated with check (bucket_id = 'fusain' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fusain : images modifiées par le propriétaire" on storage.objects
  for update to authenticated using (bucket_id = 'fusain' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fusain : images supprimées par le propriétaire" on storage.objects
  for delete to authenticated using (bucket_id = 'fusain' and (storage.foldername(name))[1] = auth.uid()::text);
