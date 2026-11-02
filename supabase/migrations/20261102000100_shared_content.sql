-- Extend the existing Supabase schema for Draftly's shared content API.
-- All changes are additive; existing rows and tables are retained.

alter table public.blogs
  add column if not exists tags text[] not null default '{}';

alter table public.newsletter_subscribers
  add column if not exists name text not null default '';

create index if not exists blogs_tags_gin_idx on public.blogs using gin (tags);

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.blogs enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.newsletter_subscribers enable row level security;

revoke all on public.profiles, public.categories, public.blogs, public.comments,
  public.likes, public.newsletter_subscribers from anon, authenticated;
grant select (id, full_name, avatar_url, created_at, updated_at) on public.profiles to anon, authenticated;
grant select on public.categories to anon, authenticated;
grant select on public.blogs to anon, authenticated;
grant insert, update, delete on public.blogs to authenticated;
grant select on public.comments, public.likes to anon, authenticated;
grant insert, update, delete on public.comments to authenticated;
grant insert, delete on public.likes to authenticated;
grant insert on public.newsletter_subscribers to anon, authenticated;

drop policy if exists "Profiles are visible to everyone" on public.profiles;
create policy "Profiles are visible to everyone" on public.profiles
  for select to anon, authenticated using (true);
drop policy if exists "Users update their own profile" on public.profiles;
create policy "Users update their own profile" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "Categories are publicly readable" on public.categories;
create policy "Categories are publicly readable" on public.categories
  for select to anon, authenticated using (true);

drop policy if exists "Published blogs are publicly readable" on public.blogs;
create policy "Published blogs are publicly readable" on public.blogs
  for select to anon, authenticated using (status = 'published' or auth.uid() = author_id);
drop policy if exists "Authors create their own blogs" on public.blogs;
create policy "Authors create their own blogs" on public.blogs
  for insert to authenticated with check (auth.uid() = author_id);
drop policy if exists "Authors update their own blogs" on public.blogs;
create policy "Authors update their own blogs" on public.blogs
  for update to authenticated using (auth.uid() = author_id) with check (auth.uid() = author_id);
drop policy if exists "Authors delete their own blogs" on public.blogs;
create policy "Authors delete their own blogs" on public.blogs
  for delete to authenticated using (auth.uid() = author_id);

drop policy if exists "Comments on visible blogs are readable" on public.comments;
create policy "Comments on visible blogs are readable" on public.comments
  for select to anon, authenticated using (
    exists (select 1 from public.blogs b where b.id = blog_id and (b.status = 'published' or b.author_id = auth.uid()))
  );
drop policy if exists "Users create comments as themselves" on public.comments;
create policy "Users create comments as themselves" on public.comments
  for insert to authenticated with check (
    auth.uid() = user_id and exists (select 1 from public.blogs b where b.id = blog_id and b.status = 'published')
  );
drop policy if exists "Users update their own comments" on public.comments;
create policy "Users update their own comments" on public.comments
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users delete their own comments" on public.comments;
create policy "Users delete their own comments" on public.comments
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "Likes are readable" on public.likes;
create policy "Likes are readable" on public.likes for select to anon, authenticated using (true);
drop policy if exists "Users create likes as themselves" on public.likes;
create policy "Users create likes as themselves" on public.likes
  for insert to authenticated with check (
    auth.uid() = user_id and exists (select 1 from public.blogs b where b.id = blog_id and b.status = 'published')
  );
drop policy if exists "Users remove their own likes" on public.likes;
create policy "Users remove their own likes" on public.likes
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "Anyone can subscribe" on public.newsletter_subscribers;
create policy "Anyone can subscribe" on public.newsletter_subscribers
  for insert to anon, authenticated with check (is_active = true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('blog-images', 'blog-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
drop policy if exists "Public can read blog images" on storage.objects;
create policy "Public can read blog images" on storage.objects
  for select to anon, authenticated using (bucket_id = 'blog-images');
drop policy if exists "Users upload images to own folder" on storage.objects;
create policy "Users upload images to own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'blog-images' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "Users update images in own folder" on storage.objects;
create policy "Users update images in own folder" on storage.objects
  for update to authenticated using (
    bucket_id = 'blog-images' and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (bucket_id = 'blog-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Users delete images in own folder" on storage.objects;
create policy "Users delete images in own folder" on storage.objects
  for delete to authenticated using (
    bucket_id = 'blog-images' and (storage.foldername(name))[1] = auth.uid()::text
  );
