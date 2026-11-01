"use strict";

(async function () {
  const api = window.PlatformAPI;
  const list = document.getElementById("blogList");
  if (!list) return;

  function makeButton(label, action, blog) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    if (blog.status === "draft" && label === "Publish") button.className = "btn-primary";
    return button;
  }

  function renderBlog(blog) {
    const card = document.createElement("article");
    card.className = "blog dashboard-article";
    const title = document.createElement("h3");
    title.textContent = blog.title;
    const meta = document.createElement("p");
    meta.textContent = `${blog.status === "published" ? "Published" : "Draft"} · Updated ${new Date(blog.updatedAt).toLocaleDateString()}`;
    const description = document.createElement("p");
    description.textContent = blog.description || blog.content.replace(/<[^>]*>/g, " ").trim().slice(0, 180) || "No content yet.";
    const status = document.createElement("span");
    status.className = `status-pill ${blog.status}`;
    status.textContent = blog.status;
    const actions = document.createElement("div");
    actions.className = "dashboard-actions";
    const edit = document.createElement("a");
    edit.href = `editor.html?id=${encodeURIComponent(blog.id)}`;
    edit.textContent = "Edit";
    actions.append(edit);
    if (blog.status === "published") {
      const view = document.createElement("a");
      view.href = `blog.html?id=${encodeURIComponent(blog.id)}`;
      view.textContent = "View";
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
    }, blog);
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
    }, blog);
    actions.append(publish, remove);
    card.append(title, meta, status, description, actions);
    return card;
  }

  async function loadDashboard() {
    list.setAttribute("aria-busy", "true");
    try {
      const result = await api.request("dashboard");
      document.getElementById("totalBlogs").textContent = String(result.counts.total || 0);
      document.getElementById("publishedBlogs").textContent = String(result.counts.published || 0);
      document.getElementById("draftBlogs").textContent = String(result.counts.drafts || 0);
      document.getElementById("subscribers").textContent = String(result.subscribers);
      document.getElementById("dashboardName").textContent = result.user.name;
      document.getElementById("dashboardEmail").textContent = result.user.email;
      const avatar = document.getElementById("dashboardAvatar");
      if (result.user.avatar) {
        avatar.src = result.user.avatar;
        avatar.hidden = false;
      }
      list.replaceChildren();
      if (!result.blogs.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        const message = document.createElement("p");
        message.textContent = "Your writing space is ready. Save a draft or publish your first article.";
        const write = document.createElement("a");
        write.href = "editor.html";
        write.className = "btn btn-primary";
        write.textContent = "Write your first article";
        empty.append(message, write);
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
