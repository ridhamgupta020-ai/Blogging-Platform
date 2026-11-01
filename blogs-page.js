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
    const text = blog.content.replace(/<[^>]*>/g, " ").trim();
    return Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 220));
  }

  function createBlogCard(blog) {
    const link = document.createElement("a");
    link.className = "blog-card";
    link.href = `blog.html?id=${encodeURIComponent(blog.id)}`;
    if (blog.coverImage) {
      const image = document.createElement("img");
      image.className = "blog-cover";
      image.src = blog.coverImage;
      image.alt = blog.title;
      image.loading = "lazy";
      link.append(image);
    }
    const content = document.createElement("div");
    content.className = "blog-content";
    const heading = document.createElement("h2");
    heading.className = "blog-title";
    heading.textContent = blog.title;
    const meta = document.createElement("p");
    meta.className = "blog-meta";
    meta.textContent = `${blog.author?.name || "Writer"} · ${new Date(blog.publishedAt || blog.createdAt).toLocaleDateString()} · ${readTime(blog)} min read`;
    const description = document.createElement("p");
    description.className = "blog-excerpt";
    description.textContent = blog.description || blog.content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
    const tags = document.createElement("div");
    tags.className = "tags";
    blog.tags.forEach((value) => {
      const badge = document.createElement("span");
      badge.textContent = `#${value}`;
      tags.append(badge);
    });
    content.append(heading, meta, description, tags);
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
        api.notice(error.message, "error", activeFilter);
      }
    } finally {
      if (currentRequest === requestId) list.removeAttribute("aria-busy");
    }
  }

  if (filterBar) filterBar.setAttribute("role", "search");
  loadBlogs(1);
})();
