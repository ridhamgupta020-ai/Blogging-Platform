"use strict";

const crypto = require("node:crypto");

const BLOG_SELECT = [
  "id", "slug", "title", "content", "excerpt", "featured_image", "category_id", "tags",
  "status", "created_at", "updated_at", "published_at",
  "category:categories(name,slug)",
  "author:profiles!blogs_author_id_fkey(id,full_name,avatar_url)"
].join(",");

function slugPart(value) {
  return String(value || "story")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || "story";
}

function readTime(content) {
  const words = String(content || "").replace(/<[^>]*>/g, " ").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

function createSupabaseContent(client, ApiError) {
  if (!client) throw new Error("Supabase content client is required.");

  async function unwrap(query, label = "Supabase content request") {
    const { data, error, count } = await query;
    if (error) {
      const failure = new ApiError(503, `${label} failed. Please try again.`);
      failure.cause = error;
      throw failure;
    }
    return { data, count };
  }

  async function categoryId(name) {
    const category = String(name || "").trim();
    if (!category) return null;
    const slug = slugPart(category).slice(0, 80);
    const found = await unwrap(client.from("categories").select("id,name,slug").eq("slug", slug).maybeSingle(), "Category lookup");
    if (found.data) return found.data.id;
    const inserted = await client.from("categories").insert({ name: category.slice(0, 80), slug }).select("id").single();
    if (!inserted.error) return inserted.data.id;
    if (inserted.error.code === "23505") {
      const raced = await unwrap(client.from("categories").select("id").eq("slug", slug).maybeSingle(), "Category lookup");
      if (raced.data) return raced.data.id;
    }
    const failure = new ApiError(503, "Category could not be saved. Please try again.");
    failure.cause = inserted.error;
    throw failure;
  }

  async function uniqueSlug(title, exceptId) {
    const base = slugPart(title);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const suffix = attempt ? `-${crypto.randomBytes(3).toString("hex")}` : "";
      const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
      let query = client.from("blogs").select("id").eq("slug", candidate);
      if (exceptId) query = query.neq("id", exceptId);
      const found = await unwrap(query.maybeSingle(), "Article slug lookup");
      if (!found.data) return candidate;
    }
    throw new ApiError(503, "A unique article URL could not be generated.");
  }

  async function loadCounts(rows, viewerId) {
    if (!rows.length) return new Map();
    const ids = rows.map((row) => row.id);
    const [likes, comments, viewerLikes] = await Promise.all([
      unwrap(client.from("likes").select("blog_id").in("blog_id", ids), "Article likes lookup"),
      unwrap(client.from("comments").select("blog_id").in("blog_id", ids), "Article comments lookup"),
      viewerId
        ? unwrap(client.from("likes").select("blog_id").eq("user_id", viewerId).in("blog_id", ids), "Your likes lookup")
        : Promise.resolve({ data: [] })
    ]);
    const counts = new Map(ids.map((id) => [id, { likes: 0, comments: 0, liked: false }]));
    for (const row of likes.data || []) counts.get(row.blog_id).likes += 1;
    for (const row of comments.data || []) counts.get(row.blog_id).comments += 1;
    for (const row of viewerLikes.data || []) counts.get(row.blog_id).liked = true;
    return counts;
  }

  function mapBlog(row, counts = {}, { includeContent = true, includeStatus = true } = {}) {
    const mapped = {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.excerpt || "",
      excerpt: row.excerpt || "",
      coverImage: row.featured_image || null,
      cover_url: row.featured_image || null,
      category: row.category?.name || "",
      tags: Array.isArray(row.tags) ? row.tags : [],
      readTime: readTime(row.content),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      author: row.author ? {
        id: row.author.id,
        name: row.author.full_name || "Writer",
        avatar: row.author.avatar_url || null
      } : { name: "Writer", avatar: null },
      likeCount: counts.likes || 0,
      commentCount: counts.comments || 0,
      liked: Boolean(counts.liked)
    };
    if (includeContent) mapped.content = row.content;
    if (includeStatus) mapped.status = row.status;
    return mapped;
  }

  async function listBlogs({ page = 1, limit = 9, query, category, tag, sort = "newest", authorId, status, viewerId } = {}) {
    let request = client.from("blogs").select(BLOG_SELECT, { count: "exact" });
    if (authorId) request = request.eq("author_id", authorId);
    if (status) request = request.eq("status", status);
    else request = request.eq("status", "published");
    if (query) {
      const escaped = query.replace(/[%,()]/g, " ").trim();
      if (escaped) request = request.or(`title.ilike.%${escaped}%,excerpt.ilike.%${escaped}%,content.ilike.%${escaped}%`);
    }
    if (category) {
      const categoryResult = await unwrap(client.from("categories").select("id").ilike("name", category).maybeSingle(), "Category filter");
      if (!categoryResult.data) return { blogs: [], total: 0, page, pages: 0, categories: await listCategories(), tags: await listTags() };
      request = request.eq("category_id", categoryResult.data.id);
    }
    if (tag) request = request.contains("tags", [tag]);
    const order = sort === "title-asc" ? "title" : sort === "title-desc" ? "title" : "published_at";
    request = request.order(order, { ascending: sort === "oldest" || sort === "title-asc", nullsFirst: false })
      .range((page - 1) * limit, page * limit - 1);
    const result = await unwrap(request, "Published articles lookup");
    const rows = result.data || [];
    const counts = await loadCounts(rows, viewerId);
    const [categories, tags] = await Promise.all([listCategories(), listTags()]);
    return {
      blogs: rows.map((row) => mapBlog(row, counts.get(row.id), { includeContent: false, includeStatus: false })),
      total: result.count || 0,
      page,
      pages: Math.ceil((result.count || 0) / limit),
      categories,
      tags
    };
  }

  async function listCategories() {
    const result = await unwrap(client.from("categories").select("name").order("name"), "Categories lookup");
    return (result.data || []).map((row) => row.name);
  }

  async function listTags() {
    const result = await unwrap(client.from("blogs").select("tags").eq("status", "published"), "Tags lookup");
    return [...new Set((result.data || []).flatMap((row) => Array.isArray(row.tags) ? row.tags : []))].sort((a, b) => a.localeCompare(b));
  }

  async function getBlog(id, { ownerId, publicOnly = true, viewerId } = {}) {
    let request = client.from("blogs").select(BLOG_SELECT).eq("id", id);
    if (ownerId) request = request.eq("author_id", ownerId);
    else if (publicOnly) request = request.eq("status", "published");
    const found = await unwrap(request.maybeSingle(), "Article lookup");
    if (!found.data) {
      if (ownerId) {
        const exists = await unwrap(client.from("blogs").select("id").eq("id", id).maybeSingle(), "Article ownership check");
        if (exists.data) throw new ApiError(403, "You cannot access this article.");
      }
      throw new ApiError(404, "Article not found.");
    }
    const counts = await loadCounts([found.data], viewerId);
    return mapBlog(found.data, counts.get(id));
  }

  async function getRelated(blog) {
    let request = client.from("blogs").select(BLOG_SELECT).eq("status", "published").neq("id", blog.id)
      .order("published_at", { ascending: false }).limit(3);
    if (blog.category_id) request = request.eq("category_id", blog.category_id);
    const result = await unwrap(request, "Related articles lookup");
    const counts = await loadCounts(result.data || []);
    return (result.data || []).map((row) => mapBlog(row, counts.get(row.id), { includeContent: false, includeStatus: false }));
  }

  async function saveBlog({ id, authorId, title, description, content, coverImage, category, tags, status }) {
    const category_id = await categoryId(category);
    const slug = await uniqueSlug(title, id);
    const now = new Date().toISOString();
    const record = {
      title, slug, excerpt: description, content, featured_image: coverImage || null,
      category_id, tags, status, updated_at: now,
      published_at: status === "published" ? now : null
    };
    let result;
    if (id) {
      const existing = await unwrap(client.from("blogs").select("id,author_id,published_at").eq("id", id).maybeSingle(), "Article ownership check");
      if (!existing.data) throw new ApiError(404, "Article not found.");
      if (existing.data.author_id !== authorId) throw new ApiError(403, "You cannot edit this article.");
      if (existing.data.status === "published" && status === "published") record.published_at = existing.data.published_at;
      result = await unwrap(client.from("blogs").update(record).eq("id", id).eq("author_id", authorId).select(BLOG_SELECT).single(), "Article update");
    } else {
      result = await unwrap(client.from("blogs").insert({ ...record, author_id: authorId, created_at: now }).select(BLOG_SELECT).single(), "Article create");
    }
    return mapBlog(result.data);
  }

  async function deleteBlog(id, authorId) {
    const existing = await unwrap(client.from("blogs").select("id,author_id").eq("id", id).maybeSingle(), "Article ownership check");
    if (!existing.data) throw new ApiError(404, "Article not found.");
    if (existing.data.author_id !== authorId) throw new ApiError(403, "You cannot delete this article.");
    await unwrap(client.from("blogs").delete().eq("id", id).eq("author_id", authorId), "Article delete");
  }

  async function uploadImage(authUserId, file) {
    if (!file || !authUserId) throw new ApiError(400, "Choose an image to upload.");
    const extension = file.mimetype === "image/png" ? "png" : file.mimetype === "image/webp" ? "webp" : "jpg";
    const objectPath = `${authUserId}/${crypto.randomUUID()}.${extension}`;
    const { error } = await client.storage.from("blog-images").upload(objectPath, file.buffer, {
      contentType: file.mimetype,
      cacheControl: "3600",
      upsert: false
    });
    if (error) {
      const failure = new ApiError(503, "Image upload failed. Please try again.");
      failure.cause = error;
      throw failure;
    }
    const { data } = client.storage.from("blog-images").getPublicUrl(objectPath);
    return data.publicUrl;
  }

  async function getProfile(id, { privateFields = false } = {}) {
    const columns = privateFields ? "id,full_name,email,avatar_url,created_at" : "id,full_name,avatar_url,created_at";
    const result = await unwrap(client.from("profiles").select(columns).eq("id", id).maybeSingle(), "Profile lookup");
    return result.data;
  }

  async function upsertProfile(user) {
    if (!user?.id || !user.email) return;
    const full_name = String(user.user_metadata?.full_name || user.user_metadata?.name || user.email.split("@")[0]).slice(0, 120);
    const avatar = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
    await unwrap(client.from("profiles").upsert({ id: user.id, full_name, email: user.email.toLowerCase(), avatar_url: avatar }, { onConflict: "id" }), "Profile sync");
  }

  async function updateProfile(id, values) {
    const result = await unwrap(client.from("profiles").update(values).eq("id", id).select("id,full_name,email,avatar_url,created_at").single(), "Profile update");
    return result.data;
  }

  async function getStats() {
    const [published, subscriberResult, authors] = await Promise.all([
      unwrap(client.from("blogs").select("id", { count: "exact", head: true }).eq("status", "published"), "Published count"),
      unwrap(client.from("newsletter_subscribers").select("id", { count: "exact", head: true }).eq("is_active", true), "Subscriber count"),
      unwrap(client.from("blogs").select("author_id").eq("status", "published"), "Creator count")
    ]);
    return { published: published.count || 0, creators: new Set((authors.data || []).map((row) => row.author_id)).size, subscribers: subscriberResult.count || 0 };
  }

  async function like(id, userId) {
    const article = await unwrap(client.from("blogs").select("id").eq("id", id).eq("status", "published").maybeSingle(), "Article lookup");
    if (!article.data) throw new ApiError(404, "Article not found.");
    const existing = await unwrap(client.from("likes").select("id").eq("blog_id", id).eq("user_id", userId).maybeSingle(), "Like lookup");
    if (existing.data) await unwrap(client.from("likes").delete().eq("id", existing.data.id).eq("user_id", userId), "Unlike article");
    else await unwrap(client.from("likes").insert({ blog_id: id, user_id: userId }), "Like article");
    const count = await unwrap(client.from("likes").select("id", { count: "exact", head: true }).eq("blog_id", id), "Like count");
    return { liked: !existing.data, likes: count.count || 0 };
  }

  async function listComments(blogId, viewerId) {
    const article = await unwrap(client.from("blogs").select("id").eq("id", blogId).eq("status", "published").maybeSingle(), "Article lookup");
    if (!article.data) throw new ApiError(404, "Article not found.");
    const result = await unwrap(client.from("comments").select("id,blog_id,user_id,content,created_at,updated_at,author:profiles!comments_user_id_fkey(id,full_name,avatar_url)").eq("blog_id", blogId).order("created_at", { ascending: false }), "Comments lookup");
    return (result.data || []).map((row) => ({ id: row.id, body: row.content, createdAt: row.created_at, updatedAt: row.updated_at, author: { id: row.author?.id, name: row.author?.full_name || "Writer", avatar: row.author?.avatar_url || null }, canEdit: Boolean(viewerId && viewerId === row.user_id) }));
  }

  async function addComment(blogId, user, body) {
    const article = await unwrap(client.from("blogs").select("id").eq("id", blogId).eq("status", "published").maybeSingle(), "Article lookup");
    if (!article.data) throw new ApiError(404, "Article not found.");
    const result = await unwrap(client.from("comments").insert({ blog_id: blogId, user_id: user.supabase_user_id, content: body }).select("id,created_at,updated_at").single(), "Comment create");
    return { id: result.data.id, body, createdAt: result.data.created_at, updatedAt: result.data.updated_at, author: { id: user.supabase_user_id, name: user.display_name, avatar: user.avatar_path }, canEdit: true };
  }

  async function editComment(id, userId, body) {
    const result = await client.from("comments").update({ content: body }).eq("id", id).eq("user_id", userId).select("id,content").maybeSingle();
    if (result.error) {
      const failure = new ApiError(503, "Comment update failed. Please try again."); failure.cause = result.error; throw failure;
    }
    if (!result.data) {
      const exists = await unwrap(client.from("comments").select("id").eq("id", id).maybeSingle(), "Comment ownership check");
      throw new ApiError(exists.data ? 403 : 404, exists.data ? "You cannot edit this comment." : "Comment not found.");
    }
    return { id, body: result.data.content };
  }

  async function deleteComment(id, userId) {
    const existing = await unwrap(client.from("comments").select("id,user_id").eq("id", id).maybeSingle(), "Comment ownership check");
    if (!existing.data) throw new ApiError(404, "Comment not found.");
    if (existing.data.user_id !== userId) throw new ApiError(403, "You cannot delete this comment.");
    await unwrap(client.from("comments").delete().eq("id", id).eq("user_id", userId), "Comment delete");
  }

  async function subscribe(email, name) {
    const result = await client.from("newsletter_subscribers").insert({ email, name, is_active: true });
    if (result.error?.code === "23505") throw new ApiError(409, "This email is already subscribed.");
    if (result.error) { const failure = new ApiError(503, "Subscription could not be saved. Please try again."); failure.cause = result.error; throw failure; }
  }

  return { listBlogs, listCategories, listTags, getBlog, getRelated, saveBlog, deleteBlog, uploadImage, getProfile, upsertProfile, updateProfile, getStats, like, listComments, addComment, editComment, deleteComment, subscribe, mapBlog };
}

module.exports = { createSupabaseContent };
