"use strict";

(async function () {
  const api = window.PlatformAPI;
  const blogId = new URLSearchParams(location.search).get("id");
  const article = document.getElementById("blog");
  if (!article) return;
  if (!blogId || !/^\d+$/.test(blogId)) {
    api.notice("Choose an article from the blog list.", "error", article);
    return;
  }

  const exportButton = article.querySelector(".export");
  try {
    const [{ blog, related }, { comments }] = await Promise.all([
      api.request(`blogs/${encodeURIComponent(blogId)}`),
      api.request(`blogs/${encodeURIComponent(blogId)}/comments`)
    ]);

    document.title = `${blog.title} | Blogging Platform`;
    const description = document.querySelector('meta[name="description"]');
    if (description && blog.description) description.content = blog.description;
    article.replaceChildren();
    if (exportButton) article.append(exportButton);

    if (blog.coverImage) {
      const image = document.createElement("img");
      image.src = blog.coverImage;
      image.alt = `Cover image for ${blog.title}`;
      image.className = "article-cover";
      article.append(image);
    }

    const title = document.createElement("h1");
    title.textContent = blog.title;
    const meta = document.createElement("div");
    meta.className = "meta";
    const author = document.createElement("a");
    author.href = `profile.html?user=${encodeURIComponent(blog.author.id)}`;
    author.textContent = blog.author.name;
    const date = document.createElement("span");
    date.textContent = new Date(blog.publishedAt || blog.createdAt).toLocaleDateString();
    const readTime = document.createElement("span");
    readTime.textContent = `${Math.max(1, Math.ceil(blog.content.replace(/<[^>]*>/g, " ").trim().split(/\s+/).length / 220))} min read`;
    meta.append(author, date, readTime);
    article.append(title, meta);

    if (blog.category) {
      const category = document.createElement("p");
      category.className = "article-category";
      category.textContent = blog.category;
      article.append(category);
    }

    const content = document.createElement("div");
    content.className = "content";
    content.innerHTML = blog.content;
    article.append(content);

    if (blog.tags.length) {
      const tags = document.createElement("div");
      tags.className = "tags";
      blog.tags.forEach((value) => {
        const tag = document.createElement("span");
        tag.textContent = `#${value}`;
        tags.append(tag);
      });
      article.append(tags);
    }

    const actions = document.createElement("div");
    actions.className = "article-actions";
    const like = document.createElement("button");
    like.type = "button";
    like.className = "like-button";
    like.setAttribute("aria-pressed", String(blog.liked));
    like.textContent = `${blog.liked ? "♥" : "♡"} ${blog.likeCount} likes`;
    like.addEventListener("click", async () => {
      like.disabled = true;
      try {
        const result = await api.request(`blogs/${blog.id}/like`, { method: "POST" });
        like.setAttribute("aria-pressed", String(result.liked));
        like.textContent = `${result.liked ? "♥" : "♡"} ${result.likes} likes`;
      } catch (error) {
        if (error.status === 401) return api.redirectToLogin();
        api.notice(error.message, "error");
      } finally {
        like.disabled = false;
      }
    });
    const share = document.createElement("button");
    share.type = "button";
    share.textContent = "Copy article link";
    share.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        api.notice("Article link copied.", "success");
      } catch {
        api.notice("Copy this URL to share the article.", "info");
      }
    });
    actions.append(like, share);
    article.append(actions);

    const commentSection = document.createElement("section");
    commentSection.className = "comments-section";
    const commentHeading = document.createElement("h2");
    commentHeading.textContent = `Comments (${comments.length})`;
    commentSection.append(commentHeading);
    const commentForm = document.createElement("form");
    commentForm.className = "comment-form";
    commentForm.innerHTML = '<label for="commentBody">Join the conversation</label><textarea id="commentBody" name="body" maxlength="2000" rows="4" required placeholder="Share a thoughtful response…"></textarea><button type="submit">Post comment</button>';
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
        heading.textContent = `${comment.author.name} · ${new Date(comment.createdAt).toLocaleDateString()}`;
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
            cancel.addEventListener("click", renderComments);
            item.replaceChildren(heading, editor, save, cancel);
          });
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Delete";
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
})();
