"use strict";

(function () {
  const api = window.PlatformAPI;
  const status = document.getElementById("status");
  const signupForm = document.getElementById("signupForm");

  function showStatus(message, type) {
    if (status) {
      status.textContent = message;
      status.className = `status ${type}`;
      status.setAttribute("role", "status");
      return;
    }
    api.notice(message, type);
  }

  async function importLegacyBrowserData() {
    let blogs = [];
    let draft = null;
    try {
      blogs = JSON.parse(localStorage.getItem("blogs") || "[]");
      draft = JSON.parse(localStorage.getItem("draftBlog") || "null");
    } catch {
      blogs = [];
      draft = null;
    }
    if (!Array.isArray(blogs)) blogs = [];
    if (!blogs.length && !draft) return;
    if (!confirm("Existing browser-only articles or drafts were found. Import them into this account now?")) return;
    const result = await api.request("migrate/local", { method: "POST", body: { blogs, draft } });
    localStorage.removeItem("blogs");
    localStorage.removeItem("draftBlog");
    localStorage.removeItem("editId");
    if (result.imported) alert(`${result.imported} article${result.imported === 1 ? "" : "s"} imported into your account.`);
  }

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!form.matches("#loginForm, #signupForm")) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const isSignup = form.id === "signupForm";
    const name = isSignup ? form.querySelector("#signupName").value.trim() : "";
    const email = form.querySelector('input[type="email"]').value.trim().toLowerCase();
    const password = form.querySelector('input[type="password"]').value;
    if (isSignup && !name) return showStatus("Enter your name.", "error");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showStatus("Enter a valid email address.", "error");
    if (isSignup && (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password))) {
      return showStatus("Use at least 12 characters with lowercase, uppercase, and a number.", "error");
    }
    if (!isSignup && !password) return showStatus("Enter your password.", "error");

    const button = form.querySelector('button[type="submit"]');
    const originalText = button?.textContent || (isSignup ? "Create Account" : "Login");
    if (button) {
      button.disabled = true;
      button.textContent = isSignup ? "Creating account…" : "Signing in…";
    }
    showStatus(isSignup ? "Creating your account…" : "Checking your account…", "info");

    try {
      if (isSignup) {
        await api.request("auth/register", { method: "POST", body: { name, email, password } });
        await importLegacyBrowserData();
        location.href = "dashboard.html";
        return;
      }

      await api.request("auth/login", { method: "POST", body: { email, password } });
      await importLegacyBrowserData();
      const remembered = document.getElementById("rememberEmail")?.checked;
      if (remembered) localStorage.setItem("rememberedEmail", email);
      else localStorage.removeItem("rememberedEmail");

      const requested = new URLSearchParams(location.search).get("next");
      const allowedPages = new Set(["dashboard.html", "profile.html", "blogs.html"]);
      location.href = allowedPages.has(requested) || /^editor\.html\?id=\d+$/.test(requested || "")
        ? requested
        : "dashboard.html";
    } catch (error) {
      showStatus(error.message, "error");
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }, true);

  const emailInput = document.getElementById("loginEmail");
  const rememberInput = document.getElementById("rememberEmail");
  const remembered = localStorage.getItem("rememberedEmail");
  if (emailInput && remembered) {
    emailInput.value = remembered;
    if (rememberInput) rememberInput.checked = true;
  }

  const togglePassword = document.getElementById("togglePassword");
  togglePassword?.addEventListener("click", () => {
    const input = document.getElementById("loginPassword");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    togglePassword.textContent = show ? "HIDE" : "SHOW";
    togglePassword.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  if (signupForm && new URLSearchParams(location.search).has("next")) {
    signupForm.querySelector("#signupName")?.focus();
  }
})();
