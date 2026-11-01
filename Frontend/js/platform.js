"use strict";

(function () {
  const api = window.PlatformAPI;

  async function renderPlatformStats() {
    const stats = document.querySelectorAll("[data-platform-stat]");
    if (!stats.length) return;
    try {
      const data = await api.request("stats");
      stats.forEach((element) => {
        const key = element.dataset.platformStat;
        if (Object.hasOwn(data, key)) element.textContent = Number(data[key]).toLocaleString();
      });
    } catch (error) {
      api.notice(error.message, "error");
    }
  }

  async function renderAuth() {
    const area = document.getElementById("authArea");
    if (!area) return;
    try {
      const { user } = await api.request("auth/me");
      area.replaceChildren();
      if (!user) {
        const item = area.tagName === "UL" ? document.createElement("li") : area;
        const login = document.createElement("a");
        login.href = "login.html";
        login.className = "login-btn";
        login.textContent = "Login";
        item.append(login);
        if (item !== area) area.append(item);
        return;
      }

      const item = area.tagName === "UL" ? document.createElement("li") : area;
      item.className = "auth-chip";
      const profile = document.createElement("a");
      profile.href = "profile.html";
      profile.textContent = user.name;
      const logout = document.createElement("button");
      logout.className = "logout-btn";
      logout.type = "button";
      logout.dataset.action = "logout";
      logout.textContent = "Logout";
      item.append(profile, logout);
      if (item !== area) area.append(item);
    } catch (error) {
      api.notice(error.message, "error");
    }
  }

  document.addEventListener("click", async (event) => {
    const hamburger = event.target.closest(".hamburger");
    if (hamburger) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const controlledId = hamburger.getAttribute("aria-controls");
      const nav = (controlledId && document.getElementById(controlledId)) ||
        hamburger.closest(".navbar, .topbar")?.querySelector(".nav-links");
      if (nav) {
        const expanded = hamburger.getAttribute("aria-expanded") === "true";
        nav.classList.toggle("active", !expanded);
        hamburger.setAttribute("aria-expanded", String(!expanded));
      }
      return;
    }

    const scrollTop = event.target.closest(".scroll-top");
    if (scrollTop) {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const button = event.target.closest("[data-action='logout'], .logout-btn");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    button.disabled = true;
    try {
      await api.request("auth/logout", { method: "POST" });
      location.href = "index.html";
    } catch (error) {
      button.disabled = false;
      api.notice(error.message, "error");
    }
  }, true);

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!form.matches("#newsletterForm, .newsletter-form, .newsletter form")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const email = form.querySelector('input[type="email"]')?.value.trim();
    const name = form.querySelector('input[name="name"], input[type="text"]')?.value.trim() || "";
    let feedback = form.querySelector("[data-newsletter-feedback], .newsletter-feedback, #newsletterFeedback, #newsletterMsg");
    if (!feedback) {
      feedback = document.createElement("p");
      feedback.dataset.newsletterFeedback = "true";
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      form.append(feedback);
    }
    if (!email) {
      api.notice("Enter a valid email address.", "error", feedback);
      return;
    }
    const submit = form.querySelector('button[type="submit"], button:not([type])');
    if (submit) {
      submit.disabled = true;
      submit.dataset.originalText = submit.textContent;
      submit.textContent = "Subscribing…";
    }
    try {
      const result = await api.request("newsletter", { method: "POST", body: { email, name } });
      api.notice(result.message, "success", feedback);
      form.reset();
    } catch (error) {
      api.notice(error.message, error.status === 409 ? "info" : "error", feedback);
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = submit.dataset.originalText || "Subscribe";
      }
    }
  }, true);

  renderAuth();
  renderPlatformStats();
})();
