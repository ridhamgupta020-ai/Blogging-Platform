"use strict";

(async function () {
  const api = window.PlatformAPI;
  const list = document.getElementById("blogList");
  if (!list) return;

  function makeButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    const icon = document.createElement("i");
    icon.className = label === "Publish" ? "bi bi-send" : label === "Unpublish" ? "bi bi-eye-slash" : "bi bi-trash3";
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    button.append(icon, text);
    button.className = `dashboard-action-btn ${label.toLowerCase()}`;
    button.addEventListener("click", action);
    return button;
  }

  function renderBlog(blog) {
    const card = document.createElement("article");
    card.className = "blog dashboard-article";
    const body = document.createElement("div");
    body.className = "dashboard-article-body";
    const headingRow = document.createElement("div");
    headingRow.className = "dashboard-article-heading";
    const title = document.createElement("h3");
    title.textContent = blog.title;
    const meta = document.createElement("p");
    meta.className = "dashboard-article-dates";
    meta.textContent = `Created ${new Date(blog.createdAt).toLocaleDateString()} · Updated ${new Date(blog.updatedAt).toLocaleDateString()}`;
    const description = document.createElement("p");
    description.className = "dashboard-article-description";
    const contentText = typeof blog.content === "string" ? blog.content.replace(/<[^>]*>/g, " ").trim() : "";
    description.textContent = blog.description || contentText.slice(0, 180) || "No content yet.";
    const status = document.createElement("span");
    status.className = `status-pill ${blog.status}`;
    status.textContent = blog.status;
    headingRow.append(title, status);
    body.append(headingRow, meta, description);
    const taxonomy = document.createElement("div");
    taxonomy.className = "dashboard-article-taxonomy";
    if (blog.category) {
      const category = document.createElement("span");
      category.className = "dashboard-category-chip";
      category.textContent = blog.category;
      taxonomy.append(category);
    }
    (Array.isArray(blog.tags) ? blog.tags : []).forEach((tag) => {
      const chip = document.createElement("span");
      chip.className = "dashboard-tag-chip";
      chip.textContent = `#${tag}`;
      taxonomy.append(chip);
    });
    if (taxonomy.childElementCount) body.append(taxonomy);
    const actions = document.createElement("div");
    actions.className = "dashboard-actions";
    const edit = document.createElement("a");
    edit.href = `editor.html?id=${encodeURIComponent(blog.id)}`;
    edit.className = "dashboard-action-btn edit";
    edit.innerHTML = '<i class="bi bi-pencil-square" aria-hidden="true"></i><span>Edit</span>';
    actions.append(edit);
    if (blog.status === "published") {
      const view = document.createElement("a");
      view.href = `blog.html?id=${encodeURIComponent(blog.id)}`;
      view.className = "dashboard-action-btn view";
      view.innerHTML = '<i class="bi bi-box-arrow-up-right" aria-hidden="true"></i><span>View</span>';
      actions.append(view);
    }
    const publish = makeButton(blog.status === "published" ? "Unpublish" : "Publish", async () => {
      publish.disabled = true;
      try {
        await api.request(`blogs/${blog.id}`, {
          method: "PATCH",
          body: {
            title: blog.title,
            description: blog.description,
            content: blog.content,
            coverImage: blog.coverImage,
            category: blog.category,
            tags: blog.tags,
            status: blog.status === "published" ? "draft" : "published"
          }
        });
        await loadDashboard();
      } catch (error) {
        api.notice(error.message, "error");
        publish.disabled = false;
      }
    });
    const remove = makeButton("Delete", async () => {
      if (!confirm(`Delete “${blog.title}”? This cannot be undone.`)) return;
      remove.disabled = true;
      try {
        await api.request(`blogs/${blog.id}`, { method: "DELETE" });
        await loadDashboard();
      } catch (error) {
        api.notice(error.message, "error");
        remove.disabled = false;
      }
    });
    actions.append(publish, remove);
    card.append(body, actions);
    return card;
  }

  async function loadDashboard() {
    list.setAttribute("aria-busy", "true");
    try {
      const result = await api.request("dashboard");
      const displayName = result.user.name || "Creator";
      document.getElementById("totalBlogs").textContent = String(result.counts.total || 0);
      document.getElementById("publishedBlogs").textContent = String(result.counts.published || 0);
      document.getElementById("draftBlogs").textContent = String(result.counts.drafts || 0);
      document.getElementById("subscribers").textContent = String(result.subscribers);
      document.getElementById("dashboardName").textContent = displayName.trim().split(/\s+/)[0];
      document.getElementById("dashboardUserName").textContent = displayName;
      document.getElementById("dashboardProfileName").textContent = displayName;
      document.getElementById("dashboardEmail").textContent = result.user.email;
      document.getElementById("sidebarSubscribers").textContent = String(result.subscribers);
      const avatar = document.getElementById("dashboardAvatar");
      const fallbackAvatar = document.getElementById("dashboardAvatarFallback");
      fallbackAvatar.textContent = displayName.trim().charAt(0).toUpperCase() || "D";
      if (result.user.avatar) {
        avatar.src = result.user.avatar;
        avatar.hidden = false;
        fallbackAvatar.hidden = true;
        avatar.onerror = () => {
          avatar.hidden = true;
          fallbackAvatar.hidden = false;
        };
      } else {
        avatar.hidden = true;
        fallbackAvatar.hidden = false;
      }
      list.replaceChildren();
      if (!result.blogs.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state dashboard-empty-state";
        const heading = document.createElement("h3");
        heading.textContent = "No stories yet";
        const message = document.createElement("p");
        message.textContent = "Start writing your first article and share your ideas.";
        const write = document.createElement("a");
        write.href = "editor.html";
        write.className = "dashboard-new-article";
        write.innerHTML = '<i class="bi bi-plus-lg" aria-hidden="true"></i> Write your first article';
        empty.append(heading, message, write);
        list.append(empty);
      } else {
        result.blogs.forEach((blog) => list.append(renderBlog(blog)));
      }
    } catch (error) {
      if (error.status === 401) {
        location.href = "login.html?next=dashboard.html";
        return;
      }
      api.notice(error.message, "error");
    } finally {
      list.removeAttribute("aria-busy");
    }
  }

  loadDashboard();
})();
