-- Additive schema for the blogging platform. No existing table or row is dropped.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 120),
  email text not null unique,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.blogs (
  id uuid primary key default extensions.gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  content text not null default '',
  excerpt text not null default '' check (char_length(excerpt) <= 500),
  featured_image text,
  category_id uuid references public.categories(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint blogs_published_timestamp check (status <> 'published' or published_at is not null)
);

create table if not exists public.comments (
  id uuid primary key default extensions.gen_random_uuid(),
  blog_id uuid not null references public.blogs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.likes (
  id uuid primary key default extensions.gen_random_uuid(),
  blog_id uuid not null references public.blogs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint likes_blog_user_unique unique (blog_id, user_id)
);

create table if not exists public.newsletter_subscribers (
  id uuid primary key default extensions.gen_random_uuid(),
  email text not null unique check (email = lower(trim(email)) and email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  subscribed_at timestamptz not null default now(),
  is_active boolean not null default true
);

create index if not exists blogs_author_updated_idx on public.blogs (author_id, updated_at desc);
create index if not exists blogs_published_idx on public.blogs (published_at desc) where status = 'published';
create index if not exists blogs_category_published_idx on public.blogs (category_id, published_at desc) where status = 'published';
create index if not exists comments_blog_created_idx on public.comments (blog_id, created_at desc);
create index if not exists likes_blog_idx on public.likes (blog_id);
create index if not exists likes_user_idx on public.likes (user_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists blogs_set_updated_at on public.blogs;
create trigger blogs_set_updated_at before update on public.blogs for each row execute function public.set_updated_at();
drop trigger if exists comments_set_updated_at on public.comments;
create trigger comments_set_updated_at before update on public.comments for each row execute function public.set_updated_at();

create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), lower(new.email))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert or update of email on auth.users
for each row execute function public.create_profile_for_new_user();

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.blogs enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.newsletter_subscribers enable row level security;

revoke all on public.profiles, public.categories, public.blogs, public.comments, public.likes, public.newsletter_subscribers from anon, authenticated;
grant select (id, full_name, avatar_url, created_at, updated_at) on public.profiles to anon, authenticated;
grant select on public.categories, public.blogs, public.comments, public.likes to anon, authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;
grant insert, update, delete on public.blogs to authenticated;
grant insert, update, delete on public.comments to authenticated;
grant insert, delete on public.likes to authenticated;
grant insert on public.newsletter_subscribers to anon, authenticated;

drop policy if exists "Profiles are visible to everyone" on public.profiles;
create policy "Profiles are visible to everyone" on public.profiles for select to anon, authenticated using (true);
drop policy if exists "Users update their own profile" on public.profiles;
create policy "Users update their own profile" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "Categories are publicly readable" on public.categories;
create policy "Categories are publicly readable" on public.categories for select to anon, authenticated using (true);

drop policy if exists "Published blogs are publicly readable" on public.blogs;
create policy "Published blogs are publicly readable" on public.blogs for select to anon, authenticated using (status = 'published' or auth.uid() = author_id);
drop policy if exists "Authors create their own blogs" on public.blogs;
create policy "Authors create their own blogs" on public.blogs for insert to authenticated with check (auth.uid() = author_id);
drop policy if exists "Authors update their own blogs" on public.blogs;
create policy "Authors update their own blogs" on public.blogs for update to authenticated using (auth.uid() = author_id) with check (auth.uid() = author_id);
drop policy if exists "Authors delete their own blogs" on public.blogs;
create policy "Authors delete their own blogs" on public.blogs for delete to authenticated using (auth.uid() = author_id);

drop policy if exists "Comments on visible blogs are readable" on public.comments;
create policy "Comments on visible blogs are readable" on public.comments for select to anon, authenticated using (
  exists (select 1 from public.blogs b where b.id = blog_id and (b.status = 'published' or b.author_id = auth.uid())
));
drop policy if exists "Users create comments as themselves" on public.comments;
create policy "Users create comments as themselves" on public.comments for insert to authenticated with check (
  auth.uid() = user_id and exists (select 1 from public.blogs b where b.id = blog_id and b.status = 'published')
);
drop policy if exists "Users update their own comments" on public.comments;
create policy "Users update their own comments" on public.comments for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users delete their own comments" on public.comments;
create policy "Users delete their own comments" on public.comments for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "Likes are readable" on public.likes;
create policy "Likes are readable" on public.likes for select to anon, authenticated using (true);
drop policy if exists "Users create likes as themselves" on public.likes;
create policy "Users create likes as themselves" on public.likes for insert to authenticated with check (
  auth.uid() = user_id and exists (select 1 from public.blogs b where b.id = blog_id and b.status = 'published')
);
drop policy if exists "Users remove their own likes" on public.likes;
create policy "Users remove their own likes" on public.likes for delete to authenticated using (auth.uid() = user_id);

-- Subscription inserts only. No client can read subscriber records.
drop policy if exists "Anyone can subscribe" on public.newsletter_subscribers;
create policy "Anyone can subscribe" on public.newsletter_subscribers for insert to anon, authenticated with check (is_active = true);

-- Public reads for rendered article images; authenticated users may write only
-- into a folder named for their Supabase Auth UUID.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('blog-images', 'blog-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "Public can read blog images" on storage.objects;
create policy "Public can read blog images" on storage.objects for select to anon, authenticated using (bucket_id = 'blog-images');
drop policy if exists "Users upload images to own folder" on storage.objects;
create policy "Users upload images to own folder" on storage.objects for insert to authenticated with check (
  bucket_id = 'blog-images' and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "Users update images in own folder" on storage.objects;
create policy "Users update images in own folder" on storage.objects for update to authenticated using (
  bucket_id = 'blog-images' and (storage.foldername(name))[1] = auth.uid()::text
) with check (bucket_id = 'blog-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Users delete images in own folder" on storage.objects;
create policy "Users delete images in own folder" on storage.objects for delete to authenticated using (
  bucket_id = 'blog-images' and (storage.foldername(name))[1] = auth.uid()::text
);
