"use strict";

(async function () {
  const api = window.PlatformAPI;
  const fields = {
    title: document.getElementById("title"),
    description: document.getElementById("description"),
    category: document.getElementById("category"),
    tags: document.getElementById("tags"),
    content: document.getElementById("content"),
    coverInput: document.getElementById("coverInput"),
    coverPreview: document.getElementById("coverPreview")
  };
  if (!fields.title || !fields.content) return;

  let user;
  try {
    ({ user } = await api.request("auth/me"));
  } catch (error) {
    api.notice(error.message, "error");
    return;
  }
  if (!user) {
    location.href = `login.html?next=${encodeURIComponent(`editor.html${location.search}`)}`;
    return;
  }

  const currentId = new URLSearchParams(location.search).get("id");
  let blogId = currentId && /^\d+$/.test(currentId) ? Number(currentId) : null;
  let coverImage = null;
  let saveTimer;
  let savePromise = null;
  let previewWasShown = false;
  const state = document.getElementById("saveState");
  const previewModal = document.getElementById("previewModal");
  const previewBody = document.getElementById("previewBody");

  function setSaveState(value, isError = false) {
    state.textContent = value;
    state.classList.toggle("error", isError);
  }

  function payload(status) {
    return {
      title: fields.title.value.trim(),
      description: fields.description.value.trim(),
      content: fields.content.innerHTML.trim(),
      coverImage,
      category: fields.category.value,
      tags: fields.tags.value.split(",").map((tag) => tag.trim()).filter(Boolean),
      status
    };
  }

  function wordCount() {
    return fields.content.innerText.trim().split(/\s+/).filter(Boolean).length;
  }

  function updateStats() {
    const words = wordCount();
    const headings = fields.content.querySelectorAll("h1, h2, h3").length;
    const tags = payload("draft").tags;
    document.getElementById("wordCount").textContent = `${words} words`;
    document.getElementById("readTime").textContent = `${words ? Math.max(1, Math.ceil(words / 200)) : 0} min read`;
    document.getElementById("headingCount").textContent = `${headings} headings`;
    document.getElementById("tagCount").textContent = String(tags.length);
    const score = Math.min(100,
      (fields.title.value.trim().length >= 40 ? 30 : fields.title.value.trim().length >= 24 ? 15 : 0) +
      (words >= 300 ? 30 : words >= 160 ? 15 : 0) +
      (tags.length >= 3 ? 20 : tags.length ? 10 : 0) +
      (coverImage ? 10 : 0) +
      (headings >= 2 ? 10 : 0)
    );
    document.getElementById("seoScore").textContent = `SEO ${score}%`;
    const checks = {
      checkTitle: fields.title.value.trim().length >= 40,
      checkWords: words >= 300,
      checkTags: tags.length >= 3,
      checkCover: Boolean(coverImage),
      checkHeadings: headings >= 2
    };
    Object.entries(checks).forEach(([id, pass]) => {
      const item = document.getElementById(id);
      item?.classList.toggle("pass", pass);
      const icon = item?.querySelector("i");
      if (icon) icon.className = pass ? "bi bi-check-circle-fill" : "bi bi-circle";
    });
  }

  async function save(status = "draft", redirect = false) {
    if (!fields.title.value.trim()) {
      if (status === "published") {
        api.notice("Add a title before publishing.", "error");
        fields.title.focus();
        return;
      }
      setSaveState("Add a title to save", true);
      return;
    }
    if (status === "published" && !fields.content.innerText.trim()) {
      api.notice("Add article content before publishing.", "error");
      fields.content.focus();
      return;
    }

    if (savePromise) await savePromise;
    const submit = document.getElementById(status === "published" ? "publishBtn" : "saveDraftBtn");
    if (submit) submit.disabled = true;
    setSaveState(status === "published" ? "Publishing…" : "Saving…");
    savePromise = api.request(blogId ? `blogs/${blogId}` : "blogs", {
      method: blogId ? "PATCH" : "POST",
      body: payload(status)
    });
    try {
      const result = await savePromise;
      blogId = result.blog.id;
      document.getElementById("lastSaved").textContent = new Date(result.blog.updatedAt).toLocaleString();
      setSaveState(status === "published" ? "Published" : "Saved");
      if (redirect) {
        location.href = status === "published" ? `blog.html?id=${blogId}` : "dashboard.html";
      }
    } catch (error) {
      setSaveState(error.message, true);
      api.notice(error.message, "error");
    } finally {
      savePromise = null;
      if (submit) submit.disabled = false;
    }
  }

  function scheduleSave() {
    setSaveState("Unsaved changes");
    updateStats();
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => save("draft"), 1000);
  }

  function setCover(src) {
    coverImage = src;
    if (!src) {
      fields.coverPreview.removeAttribute("src");
      fields.coverPreview.hidden = true;
      return;
    }
    fields.coverPreview.src = src;
    fields.coverPreview.hidden = false;
    updateStats();
  }

  async function uploadFile(file) {
    const data = new FormData();
    data.append("image", file);
    const result = await api.request("uploads/images", { method: "POST", body: data });
    return result.image;
  }

  fields.coverInput.addEventListener("change", async () => {
    const file = fields.coverInput.files?.[0];
    if (!file) return;
    try {
      setSaveState("Uploading image…");
      setCover(await uploadFile(file));
      scheduleSave();
    } catch (error) {
      setSaveState(error.message, true);
      api.notice(error.message, "error");
    }
  });

  fields.coverInput.accept = "image/jpeg,image/png,image/webp";
  [fields.title, fields.description, fields.category, fields.tags, fields.content].forEach((field) => {
    field.addEventListener("input", scheduleSave);
    field.addEventListener("change", scheduleSave);
  });

  window.cmd = (command, value = null) => {
    fields.content.focus();
    document.execCommand(command, false, value);
    updateStats();
    scheduleSave();
  };
  window.applyTemplate = () => {
    const select = document.getElementById("templateSelect");
    const templates = {
      seo: "<h1>Article title</h1><p>Meta description</p><h2>Introduction</h2><p>Start with the reader's problem.</p><h2>Key insights</h2><p>Explain the ideas with examples.</p><h2>Conclusion</h2><p>Summarize the next step.</p>",
      blog: "<h2>Introduction</h2><p>Introduce your idea.</p><h2>Main points</h2><p>Share the details and examples.</p><h2>Conclusion</h2><p>Close with a useful takeaway.</p>",
      tutorial: "<h2>What you will learn</h2><ul><li>First step</li><li>Second step</li></ul><h2>Final result</h2><p>Describe the outcome.</p>",
      news: "<h2>What happened</h2><p>Summarize the announcement.</p><h2>Why it matters</h2><p>Explain its impact.</p>",
      case: "<h2>The challenge</h2><p>Describe the problem.</p><h2>The approach</h2><p>Explain the solution.</p><h2>The results</h2><p>Share what changed.</p>",
      review: "<h2>Overview</h2><p>Introduce the product.</p><h2>Pros and cons</h2><ul><li>Strength</li><li>Trade-off</li></ul><h2>Verdict</h2><p>Who should use it?</p>",
      markdown: "<h2>Introduction</h2><p>Start your draft here.</p>"
    };
    if (select.value && templates[select.value]) {
      fields.content.innerHTML = templates[select.value];
      select.value = "";
      scheduleSave();
    }
  };
  window.insertLink = () => {
    const url = prompt("Enter a link URL");
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) throw new Error();
      window.cmd("createLink", parsed.href);
    } catch {
      api.notice("Enter a valid http, https, or email link.", "error");
    }
  };
  window.uploadImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const src = await uploadFile(file);
        window.cmd("insertImage", src);
      } catch (error) {
        api.notice(error.message, "error");
      }
    });
    input.click();
  };

  document.getElementById("publishBtn").addEventListener("click", () => save("published", true));
  document.getElementById("saveDraftBtn").addEventListener("click", () => save("draft", true));
  document.getElementById("clearDraftBtn").addEventListener("click", () => {
    if (!confirm("Clear this article from the editor? Saved drafts remain in your dashboard.")) return;
    fields.title.value = "";
    fields.description.value = "";
    fields.category.value = "";
    fields.tags.value = "";
    fields.content.innerHTML = "";
    setCover(null);
    blogId = null;
    if (currentId) history.replaceState(null, "", "editor.html");
    setSaveState("Cleared");
    updateStats();
  });
  document.getElementById("previewBtn").addEventListener("click", () => {
    previewBody.replaceChildren();
    const title = document.createElement("h1");
    title.textContent = fields.title.value.trim() || "Untitled article";
    previewBody.append(title);
    if (coverImage) {
      const image = document.createElement("img");
      image.src = coverImage;
      image.alt = "Article cover";
      previewBody.append(image);
    }
    const content = document.createElement("div");
    content.innerHTML = fields.content.innerHTML;
    previewBody.append(content);
    previewModal.hidden = false;
  });
  document.getElementById("closePreviewBtn").addEventListener("click", () => {
    previewModal.hidden = true;
  });
  previewModal.addEventListener("click", (event) => {
    if (event.target === previewModal) previewModal.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save("draft");
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      save("published", true);
    }
    if (event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      document.getElementById("previewBtn").click();
    }
    if (event.key === "Escape" && !previewModal.hidden) previewModal.hidden = true;
  });

  if (blogId) {
    try {
      const { blogs } = await api.request("dashboard");
      const blog = blogs.find((entry) => entry.id === blogId);
      if (!blog) throw new Error("Article not found in your account.");
      fields.title.value = blog.title;
      fields.description.value = blog.description;
      fields.category.value = blog.category;
      fields.tags.value = blog.tags.join(", ");
      fields.content.innerHTML = blog.content;
      setCover(blog.coverImage);
      document.querySelector(".editor-panel h1").textContent = "Edit Blog";
      updateStats();
      setSaveState("Loaded");
    } catch (error) {
      api.notice(error.message, "error");
    }
  } else {
    updateStats();
  }
})();
