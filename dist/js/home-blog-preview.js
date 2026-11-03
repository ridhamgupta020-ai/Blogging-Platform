"use strict";

(async function loadPublishedStoryPreviews() {
  const track = document.querySelector(".gallery-track");
  if (!track || !window.PlatformAPI) return;

  function stateMessage(message, type = "info") {
    const state = document.createElement("p");
    state.className = `home-preview-state ${type}`;
    state.setAttribute("role", type === "error" ? "alert" : "status");
    state.textContent = message;
    track.replaceChildren(state);
  }

  stateMessage("Loading published stories…");
  track.setAttribute("aria-busy", "true");
  try {
    const result = await window.PlatformAPI.request("blogs?limit=4&sort=newest");
    track.replaceChildren();
    if (!result.blogs.length) {
      stateMessage("No published stories yet. Be the first to share one.");
      return;
    }
    result.blogs.forEach((blog) => {
      const card = document.createElement("a");
      card.className = "gallery-card";
      card.href = `blog.html?id=${encodeURIComponent(blog.id)}`;
      if (blog.cover_url || blog.coverImage) {
        const image = document.createElement("img");
        image.src = blog.cover_url || blog.coverImage;
        image.alt = `Cover image for ${blog.title}`;
        image.loading = "lazy";
        image.decoding = "async";
        card.append(image);
      }
      const category = document.createElement("span");
      category.textContent = blog.category || "Story";
      const title = document.createElement("h3");
      title.textContent = blog.title;
      const excerpt = document.createElement("p");
      excerpt.textContent = blog.excerpt || blog.description || "A newly published story from the Draftly community.";
      card.append(category, title, excerpt);
      track.append(card);
    });
  } catch {
    stateMessage("Published stories couldn't load. Please refresh to try again.", "error");
  } finally {
    track.removeAttribute("aria-busy");
  }
})();
