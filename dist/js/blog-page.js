"use strict";

(async function () {
  const api = window.PlatformAPI;
  const blogId = new URLSearchParams(location.search).get("id");
  const article = document.getElementById("blog");
  if (!article) return;
  if (!blogId || !(/^[0-9]+$/.test(blogId) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(blogId))) {
    api.notice("Choose an article from the blog list.", "error", article);
    return;
  }

  const exportButton = article.querySelector(".export");
  exportButton?.addEventListener("click", () => window.print());
  try {
    const [{ blog, related }, { comments }] = await Promise.all([
      api.request(`blogs/${encodeURIComponent(blogId)}`),
      api.request(`blogs/${encodeURIComponent(blogId)}/comments`)
    ]);

    document.title = `${blog.title} | Draftly`;
    const description = document.querySelector('meta[name="description"]');
    if (description && blog.description) description.content = blog.description;
    article.replaceChildren();
    if (exportButton) article.append(exportButton);

    const printContent = document.createElement("div");
    printContent.className = "article-print-content";
    article.append(printContent);

    if (blog.coverImage) {
      const image = document.createElement("img");
      image.src = blog.coverImage;
      image.alt = `Cover image for ${blog.title}`;
      image.className = "article-cover";
      image.addEventListener("error", () => {
        image.replaceWith(createCoverPlaceholder());
      }, { once: true });
      printContent.append(image);
    } else {
      printContent.append(createCoverPlaceholder());
    }

    const title = document.createElement("h1");
    title.className = "article-title";
    title.textContent = blog.title;
    const meta = document.createElement("div");
    meta.className = "meta";
    const author = document.createElement("a");
    author.href = `profile.html?user=${encodeURIComponent(blog.author.id)}`;
    author.textContent = blog.author.name;
    const date = document.createElement("span");
    date.textContent = new Date(blog.publishedAt || blog.createdAt).toLocaleDateString();
    date.className = "meta-item";
    const readTime = document.createElement("span");
    const articleText = document.createElement("div");
    articleText.innerHTML = blog.content;
    readTime.textContent = `${Math.max(1, Math.ceil(articleText.textContent.trim().split(/\s+/).filter(Boolean).length / 220))} min read`;
    readTime.className = "meta-item";
    author.className = "meta-item";
    meta.append(author, date, readTime);
    if (blog.category) {
      const category = document.createElement("span");
      category.className = "meta-item article-category";
      category.textContent = blog.category;
      meta.append(category);
    }
    printContent.append(title, meta);

    const content = document.createElement("div");
    content.className = "content";
    content.innerHTML = blog.content;
    printContent.append(content);

    if (Array.isArray(blog.tags) && blog.tags.length) {
      const tags = document.createElement("div");
      tags.className = "tags";
      blog.tags.forEach((value) => {
        const tag = document.createElement("span");
        tag.textContent = `#${value}`;
        tags.append(tag);
      });
      printContent.append(tags);
    }

    const actions = document.createElement("div");
    actions.className = "article-actions";
    const like = document.createElement("button");
    like.type = "button";
    like.className = "like-button";
    like.setAttribute("aria-pressed", String(blog.liked));
    like.innerHTML = `<span aria-hidden="true">${blog.liked ? "♥" : "♡"}</span><span>${blog.likeCount}</span><span class="action-label">Like</span>`;
    like.addEventListener("click", async () => {
      like.disabled = true;
      try {
        const result = await api.request(`blogs/${blog.id}/like`, { method: "POST" });
        like.setAttribute("aria-pressed", String(result.liked));
        like.innerHTML = `<span aria-hidden="true">${result.liked ? "♥" : "♡"}</span><span>${result.likes}</span><span class="action-label">Like</span>`;
      } catch (error) {
        if (error.status === 401) return api.redirectToLogin();
        api.notice(error.message, "error");
      } finally {
        like.disabled = false;
      }
    });
    const share = document.createElement("button");
    share.type = "button";
    share.innerHTML = '<span aria-hidden="true">↗</span><span>Copy Article Link</span>';
    share.addEventListener("click", async () => {
      try {
        await copyArticleUrl();
        api.notice("Article link copied.", "success");
      } catch (error) {
        api.notice(error.message || "Your browser couldn't copy the article link.", "error");
      }
    });
    actions.append(like, share);
    article.append(actions);

    const commentSection = document.createElement("section");
    commentSection.className = "comments-section";
    const commentHeading = document.createElement("h2");
    commentHeading.textContent = `Comments (${comments.length})`;
    const commentSubtitle = document.createElement("p");
    commentSubtitle.className = "comments-subtitle";
    commentSubtitle.textContent = "Join the conversation";
    commentSection.append(commentHeading, commentSubtitle);
    const commentForm = document.createElement("form");
    commentForm.className = "comment-form";
    commentForm.innerHTML = '<label class="sr-only" for="commentBody">Your comment</label><textarea id="commentBody" name="body" maxlength="2000" rows="4" required placeholder="Share a thoughtful response..."></textarea><button type="submit">Post Comment</button>';
    commentForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = commentForm.querySelector("textarea");
      const button = commentForm.querySelector("button");
      button.disabled = true;
      try {
        const result = await api.request(`blogs/${blog.id}/comments`, { method: "POST", body: { body: input.value.trim() } });
        input.value = "";
        comments.unshift(result.comment);
        renderComments();
      } catch (error) {
        if (error.status === 401) return api.redirectToLogin();
        api.notice(error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
    const commentList = document.createElement("div");
    commentList.className = "comment-list";
    commentSection.append(commentForm, commentList);
    article.append(commentSection);

    function renderComments() {
      commentHeading.textContent = `Comments (${comments.length})`;
      commentList.replaceChildren();
      if (!comments.length) {
        const empty = document.createElement("p");
        empty.textContent = "No comments yet. Start the conversation.";
        commentList.append(empty);
        return;
      }
      comments.forEach((comment) => {
        const item = document.createElement("article");
        item.className = "comment";
        const heading = document.createElement("h3");
        heading.className = "comment-meta";
        const authorName = document.createElement("span");
        authorName.className = "comment-author";
        authorName.textContent = comment.author.name;
        const date = document.createElement("time");
        date.dateTime = comment.createdAt;
        date.textContent = new Date(comment.createdAt).toLocaleDateString();
        heading.append(authorName, date);
        const body = document.createElement("p");
        body.textContent = comment.body;
        item.append(heading, body);
        if (comment.canEdit) {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.textContent = "Edit";
          edit.addEventListener("click", () => {
            const editor = document.createElement("textarea");
            editor.value = comment.body;
            editor.maxLength = 2000;
            const save = document.createElement("button");
            save.type = "button";
            save.textContent = "Save";
            save.className = "comment-edit-action";
            save.addEventListener("click", async () => {
              try {
                const result = await api.request(`comments/${comment.id}`, { method: "PATCH", body: { body: editor.value.trim() } });
                comment.body = result.body;
                renderComments();
              } catch (error) {
                api.notice(error.message, "error");
              }
            });
            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.textContent = "Cancel";
            cancel.className = "comment-edit-action";
            cancel.addEventListener("click", renderComments);
            item.replaceChildren(heading, editor, save, cancel);
          });
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Delete";
          remove.className = "comment-edit-action";
          remove.addEventListener("click", async () => {
            if (!confirm("Delete this comment?")) return;
            try {
              await api.request(`comments/${comment.id}`, { method: "DELETE" });
              comments.splice(comments.indexOf(comment), 1);
              renderComments();
            } catch (error) {
              api.notice(error.message, "error");
            }
          });
          item.append(edit, remove);
        }
        commentList.append(item);
      });
    }
    renderComments();

    if (related.length) {
      const relatedSection = document.createElement("section");
      relatedSection.className = "related-articles";
      const relatedHeading = document.createElement("h2");
      relatedHeading.textContent = "More to explore";
      relatedSection.append(relatedHeading);
      related.forEach((item) => {
        const link = document.createElement("a");
        link.href = `blog.html?id=${encodeURIComponent(item.id)}`;
        link.textContent = item.title;
        relatedSection.append(link);
      });
      article.append(relatedSection);
    }
  } catch (error) {
    article.replaceChildren();
    api.notice(error.message, "error", article);
  }

  function createCoverPlaceholder() {
    const placeholder = document.createElement("div");
    placeholder.className = "article-cover-placeholder";
    placeholder.setAttribute("role", "img");
    placeholder.setAttribute("aria-label", "Draftly article cover placeholder");
    placeholder.innerHTML = '<span class="cover-flower" aria-hidden="true">✳</span><span class="cover-wordmark">Draftly</span><span class="cover-caption">A space for thoughtful stories</span>';
    return placeholder;
  }

  async function copyArticleUrl() {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(location.href);
        return;
      } catch {
      }
    }
    const input = document.createElement("textarea");
    input.value = location.href;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("Your browser couldn't copy the article link.");
  }
})();
