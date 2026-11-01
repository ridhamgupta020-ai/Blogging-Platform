"use strict";

(async function () {
  const api = window.PlatformAPI;
  const query = new URLSearchParams(location.search);
  const publicId = query.get("user");
  const profileEditor = document.getElementById("profileEditor");
  const list = document.getElementById("profileArticles");

  function renderArticles(blogs) {
    list.replaceChildren();
    if (!blogs.length) {
      const empty = document.createElement("p");
      empty.textContent = "No published articles yet.";
      list.append(empty);
      return;
    }
    blogs.forEach((blog) => {
      const link = document.createElement("a");
      link.className = "blog-card";
      link.href = `blog.html?id=${encodeURIComponent(blog.id)}`;
      const title = document.createElement("h3");
      title.textContent = blog.title;
      const description = document.createElement("p");
      description.textContent = blog.description || blog.content.replace(/<[^>]*>/g, " ").trim().slice(0, 170);
      link.append(title, description);
      list.append(link);
    });
  }

  try {
    let user;
    let articles;
    if (publicId) {
      const [profile, posts] = await Promise.all([
        api.request(`users/${encodeURIComponent(publicId)}`),
        api.request(`users/${encodeURIComponent(publicId)}/blogs`)
      ]);
      user = profile.user;
      articles = posts.blogs;
      document.getElementById("profileArticlesHeading").textContent = `${user.name}'s published articles`;
    } else {
      const profile = await api.request("profile");
      user = profile.user;
      const posts = await api.request("profile/blogs?status=published");
      articles = posts.blogs;
      profileEditor.hidden = false;
      document.getElementById("profileNameInput").value = user.name;
      document.getElementById("profileEmailInput").value = user.email;

      document.getElementById("profileForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const status = document.getElementById("profileStatus");
        try {
          const result = await api.request("profile", {
            method: "PATCH",
            body: {
              name: document.getElementById("profileNameInput").value.trim(),
              email: document.getElementById("profileEmailInput").value.trim(),
              currentPassword: document.getElementById("currentPasswordForEmail").value
            }
          });
          user = result.user;
          document.getElementById("profileName").textContent = user.name;
          document.getElementById("profileBio").textContent = user.email;
          status.textContent = "Profile updated.";
          status.className = "status success";
        } catch (error) {
          status.textContent = error.message;
          status.className = "status error";
        }
      });

      document.getElementById("avatarForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const button = event.currentTarget.querySelector("button");
        button.disabled = true;
        try {
          const result = await api.request("profile/avatar", { method: "POST", body: formData });
          const avatar = document.getElementById("profileAvatar");
          avatar.src = result.avatar;
          avatar.hidden = false;
          api.notice("Profile photo updated.", "success");
        } catch (error) {
          api.notice(error.message, "error");
        } finally {
          button.disabled = false;
        }
      });

      document.getElementById("passwordForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector("button");
        button.disabled = true;
        try {
          await api.request("profile/password", {
            method: "PATCH",
            body: {
              currentPassword: form.querySelector('[name="currentPassword"]').value,
              newPassword: form.querySelector('[name="newPassword"]').value
            }
          });
          form.reset();
          api.notice("Password changed successfully.", "success");
        } catch (error) {
          api.notice(error.message, "error");
        } finally {
          button.disabled = false;
        }
      });
    }

    document.getElementById("profileName").textContent = user.name;
    document.getElementById("profileBio").textContent = user.email || "Published writer";
    if (user.avatar) {
      const avatar = document.getElementById("profileAvatar");
      avatar.src = user.avatar;
      avatar.hidden = false;
    }
    renderArticles(articles);
  } catch (error) {
    if (!publicId && error.status === 401) {
      location.href = "login.html?next=profile.html";
      return;
    }
    api.notice(error.message, "error");
  }
})();
