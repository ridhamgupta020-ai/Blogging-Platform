"use strict";

(function () {
  const apiBasePromise = fetch("/runtime-config.json", { cache: "no-store" })
    .then((response) => response.ok ? response.json() : {})
    .then((config) => typeof config.apiBaseUrl === "string" ? config.apiBaseUrl.replace(/\/$/, "") : "")
    .catch(() => "");

  function absolutizeUploads(value, base) {
    if (Array.isArray(value)) return value.map((item) => absolutizeUploads(item, base));
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) value[key] = absolutizeUploads(item, base);
      return value;
    }
    if (typeof value !== "string" || !base) return value;
    if (value.startsWith("/uploads/")) return `${base}${value}`;
    return value.replace(/(src=["'])\/uploads\//gi, `$1${base}/uploads/`);
  }

  try {
    localStorage.removeItem("loggedIn");
    const legacyUser = JSON.parse(localStorage.getItem("user") || "null");
    if (legacyUser?.password) localStorage.removeItem("user");
  } catch {
  }

  async function request(url, options = {}) {
    const apiBase = await apiBasePromise;
    const headers = new Headers(options.headers || {});
    let body = options.body;
    if (body && !(body instanceof FormData) && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }

    const path = url.startsWith("/api/") || url.startsWith("/uploads/")
      ? url
      : `/api/${url.replace(/^\/+/, "")}`;
    const response = await fetch(apiBase ? `${apiBase}${path}` : path, {
      ...options,
      body,
      headers,
      credentials: "include",
      cache: "no-store"
    });

    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return absolutizeUploads(payload, apiBase);
  }

  function notice(message, type = "info", target) {
    let output = target;
    if (!output) {
      output = document.querySelector("[data-app-notice]");
      if (!output) {
        output = document.createElement("p");
        output.dataset.appNotice = "true";
        output.className = "app-notice";
        output.setAttribute("role", "status");
        output.setAttribute("aria-live", "polite");
        const main = document.querySelector("main") || document.body;
        main.prepend(output);
      }
    }
    output.textContent = message;
    output.className = `app-notice ${type}`;
    output.hidden = false;
  }

  function redirectToLogin() {
    const next = `${location.pathname.split("/").pop() || "index.html"}${location.search}`;
    location.href = `login.html?next=${encodeURIComponent(next)}`;
  }

  window.PlatformAPI = {
    request,
    notice,
    redirectToLogin
  };
})();
