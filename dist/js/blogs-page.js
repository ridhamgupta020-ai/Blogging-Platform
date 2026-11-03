"use strict";

(function () {
  const api = window.PlatformAPI;
  const list = document.getElementById("blogList");
  if (!list) return;

  const search = document.getElementById("searchInput");
  const category = document.getElementById("categorySelect");
  const tag = document.getElementById("tagSelect");
  const sort = document.getElementById("sortSelect");
  const clear = document.getElementById("clearFiltersBtn");
  const activeFilter = document.getElementById("activeFilter");
  const totalPosts = document.getElementById("totalPosts");
  const totalTags = document.getElementById("totalTags");
  const averageRead = document.getElementById("avgRead");
  const tagCloud = document.getElementById("tagCloud");
  const featured = document.getElementById("featuredBlog");
  const filterBar = document.querySelector(".filter-bar");
  const pagination = document.createElement("nav");
  pagination.className = "pagination";
  pagination.setAttribute("aria-label", "Blog pages");
  list.after(pagination);

  let page = 1;
  let requestId = 0;
  let debounceTimer;

  if (category) category.addEventListener("change", () => loadBlogs(1));
  if (tag) tag.addEventListener("change", () => loadBlogs(1));
  if (sort) sort.addEventListener("change", () => loadBlogs(1));
  search?.addEventListener("input", () => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => loadBlogs(1), 250);
  });
  clear?.addEventListener("click", () => {
    if (search) search.value = "";
    if (category) category.value = "all";
    if (tag) tag.value = "all";
    if (sort) sort.value = "newest";
    loadBlogs(1);
  });

  function makeOption(value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }

  function updateFilters(categories, tags) {
    if (category) {
      const selected = category.value;
      category.replaceChildren(makeOption("all", "All categories"), ...categories.map((item) => makeOption(item, item)));
      if (categories.includes(selected)) category.value = selected;
    }
    if (tag) {
      const selected = tag.value;
      tag.replaceChildren(makeOption("all", "All tags"), ...tags.map((item) => makeOption(item, item)));
      if (tags.includes(selected)) tag.value = selected;
    }
    if (tagCloud) {
      tagCloud.replaceChildren();
      tags.slice(0, 14).forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tag-filter";
        button.textContent = item;
        button.addEventListener("click", () => {
          if (tag) tag.value = item;
          loadBlogs(1);
        });
        tagCloud.append(button);
      });
      if (!tags.length) tagCloud.textContent = "Tags will appear as articles are published.";
    }
  }

  function readTime(blog) {
    const savedReadTime = blog.read_time ?? blog.readTime;
    if (Number.isFinite(Number(savedReadTime))) return Math.max(1, Number(savedReadTime));
    const text = blog.content.replace(/<[^>]*>/g, " ").trim();
    return Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 220));
  }

  function createBlogMedia(blog, className, decorative = false) {
    const media = document.createElement("div");
    media.className = className;
    const image = document.createElement("img");
    image.className = "blog-cover";
    const fallback = "/images/6.jpg";
    const coverUrl = blog.cover_url || blog.coverImage;
    const source = typeof coverUrl === "string" && coverUrl.trim()
      ? coverUrl.trim()
      : fallback;
    image.alt = decorative ? "" : source === fallback ? "Illustration of creators working on a story" : `Cover image for ${blog.title}`;
    image.loading = "lazy";
    image.decoding = "async";
    image.dataset.fallbackUsed = source === fallback ? "true" : "false";
    image.addEventListener("error", () => {
      if (image.dataset.fallbackUsed === "true") {
        image.hidden = true;
        media.classList.add("is-fallback");
        return;
      }
      image.dataset.fallbackUsed = "true";
      image.alt = decorative ? "" : "Illustration of creators working on a story";
      image.src = fallback;
    });
    image.src = source;
    media.append(image);
    return media;
  }

  function renderFeatured(blog) {
    if (!featured) return;
    if (!blog) {
      featured.hidden = true;
      return;
    }
    featured.href = `blog.html?id=${encodeURIComponent(blog.id)}`;
    featured.querySelector(".featured-blog-art")?.replaceChildren(createBlogMedia(blog, "featured-blog-media", true));
    const categoryLabel = featured.querySelector("[data-featured-category]");
    const title = featured.querySelector("[data-featured-title]");
    const description = featured.querySelector("[data-featured-description]");
    const meta = featured.querySelector("[data-featured-meta]");
    if (categoryLabel) categoryLabel.textContent = blog.category || "Featured story";
    if (title) title.textContent = blog.title;
    if (description) description.textContent = blog.excerpt || blog.description || "A newly published story from the Draftly community.";
    if (meta) meta.textContent = `${blog.author?.name || "Writer"} · ${readTime(blog)} min read`;
    featured.hidden = false;
  }

  function createBlogCard(blog) {
    const link = document.createElement("a");
    link.className = "blog-card";
    link.href = `blog.html?id=${encodeURIComponent(blog.id)}`;
    link.append(createBlogMedia(blog, "blog-media"));
    const content = document.createElement("div");
    content.className = "blog-content";
    const categoryBadge = document.createElement("span");
    categoryBadge.className = "blog-category";
    categoryBadge.textContent = blog.category || "Story";
    const heading = document.createElement("h2");
    heading.className = "blog-title";
    heading.textContent = blog.title;
    const meta = document.createElement("p");
    meta.className = "blog-meta";
    meta.textContent = `${blog.author?.name || "Writer"} · ${new Date(blog.published_at || blog.publishedAt || blog.createdAt).toLocaleDateString()} · ${readTime(blog)} min read`;
    const description = document.createElement("p");
    description.className = "blog-excerpt";
    description.textContent = blog.excerpt || blog.description || "A newly published story from the Draftly community.";
    const tags = document.createElement("div");
    tags.className = "tags";
    (Array.isArray(blog.tags) ? blog.tags : []).forEach((value) => {
      const badge = document.createElement("span");
      badge.textContent = `#${value}`;
      tags.append(badge);
    });
    const readLink = document.createElement("span");
    readLink.className = "blog-read-link";
    readLink.textContent = "Read story →";
    content.append(categoryBadge, heading, meta, description, tags, readLink);
    link.append(content);
    return link;
  }

  function renderPagination(pages) {
    pagination.replaceChildren();
    if (pages <= 1) return;
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "Previous";
    previous.disabled = page <= 1;
    previous.addEventListener("click", () => loadBlogs(page - 1));
    const label = document.createElement("span");
    label.textContent = `Page ${page} of ${pages}`;
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Next";
    next.disabled = page >= pages;
    next.addEventListener("click", () => loadBlogs(page + 1));
    pagination.append(previous, label, next);
  }

  async function loadBlogs(nextPage = page) {
    const currentRequest = ++requestId;
    page = nextPage;
    const params = new URLSearchParams({
      page: String(page),
      q: search?.value.trim() || "",
      sort: sort?.value || "newest"
    });
    if (category?.value && category.value !== "all") params.set("category", category.value);
    if (tag?.value && tag.value !== "all") params.set("tag", tag.value);
    list.setAttribute("aria-busy", "true");
    if (activeFilter) activeFilter.textContent = "Loading articles…";
    try {
      const result = await api.request(`blogs?${params}`);
      if (currentRequest !== requestId) return;
      list.replaceChildren();
      result.blogs.forEach((blog) => list.append(createBlogCard(blog)));
      renderFeatured(result.blogs[0]);
      if (!result.blogs.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        const heading = document.createElement("h3");
        heading.textContent = "No articles found";
        const message = document.createElement("p");
        message.textContent = "Try another search or category, or be the first to publish a story.";
        empty.append(heading, message);
        list.append(empty);
      }
      updateFilters(result.categories, result.tags);
      if (totalPosts) totalPosts.textContent = String(result.total);
      if (totalTags) totalTags.textContent = String(result.tags.length);
      if (averageRead) {
        const average = result.blogs.length
          ? Math.round(result.blogs.reduce((sum, blog) => sum + readTime(blog), 0) / result.blogs.length)
          : 0;
        averageRead.textContent = `${average} min`;
      }
      if (activeFilter) {
        const parts = [];
        if (search?.value.trim()) parts.push(`Search: “${search.value.trim()}”`);
        if (category?.value !== "all" && category?.value) parts.push(`Category: ${category.value}`);
        if (tag?.value !== "all" && tag?.value) parts.push(`Tag: ${tag.value}`);
        activeFilter.textContent = parts.length ? `${result.total} result${result.total === 1 ? "" : "s"} · ${parts.join(" · ")}` : `${result.total} published article${result.total === 1 ? "" : "s"}`;
      }
      renderPagination(result.pages);
    } catch (error) {
      if (currentRequest === requestId) {
        list.replaceChildren();
        renderFeatured(null);
        api.notice(error.message, "error", activeFilter);
      }
    } finally {
      if (currentRequest === requestId) list.removeAttribute("aria-busy");
    }
  }

  if (filterBar) filterBar.setAttribute("role", "search");
  loadBlogs(1);
})();
