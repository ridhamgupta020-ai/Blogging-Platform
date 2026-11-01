"use strict";

(async function forwardRootOAuthCallback() {
  if (location.pathname !== "/") return;

  const incoming = new URLSearchParams(location.search);
  const callbackParams = new URLSearchParams();
  for (const key of ["code", "sb_flow_id", "error", "error_description", "error_code"]) {
    const value = incoming.get(key);
    if (value) callbackParams.set(key, value);
  }
  if (!callbackParams.has("code") && !callbackParams.has("error")) return;

  try {
    const response = await fetch("/runtime-config.json", { cache: "no-store" });
    const config = response.ok ? await response.json() : {};
    const backendUrl = typeof config.apiBaseUrl === "string" ? config.apiBaseUrl.replace(/\/$/, "") : "";

    if (!backendUrl) {
      if (["localhost", "127.0.0.1"].includes(location.hostname)) {
        location.replace(`/auth/callback?${callbackParams.toString()}`);
      }
      return;
    }

    const callbackUrl = new URL("/auth/callback", backendUrl);
    callbackUrl.search = callbackParams.toString();
    location.replace(callbackUrl.href);
  } catch (error) {
    console.error("Could not forward the OAuth callback to the backend.", error);
  }
})();
