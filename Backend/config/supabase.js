"use strict";

const { createClient } = require("@supabase/supabase-js");
const { createServerClient } = require("@supabase/ssr");

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(url && publishableKey && secretKey);
const isProduction = process.env.NODE_ENV === "production";

function publicBaseUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) origin.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash || (isProduction && parsed.protocol !== "https:")) {
    throw new Error(`${name} must be an HTTPS origin in production and must not include a path.`);
  }
  return parsed.origin;
}

const localUrl = `http://localhost:${process.env.PORT || 3000}`;
const frontendUrl = publicBaseUrl(process.env.PUBLIC_APP_URL || localUrl, "PUBLIC_APP_URL");
const backendUrl = publicBaseUrl(process.env.BACKEND_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || localUrl, "BACKEND_PUBLIC_URL");
const pkceStorageKey = "draftly-google-oauth";
const pkceCookiePattern = new RegExp(`^${pkceStorageKey}(?:-code-verifier|-flows-code-verifier|-flow-[A-Za-z0-9_-]{8,64}-code-verifier)(?:\\.\\d+)?$`);

function getPkceCookies(req) {
  return (req.headers.cookie || "").split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator > 0) {
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (pkceCookiePattern.test(name)) cookies.push({ name, value });
    }
    return cookies;
  }, []);
}

if (configured && !/^https:\/\//i.test(url)) {
  throw new Error("SUPABASE_URL must be an HTTPS URL.");
}

// These clients are server-only. Never import this module from Frontend/.
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const publicClient = configured ? createClient(url, publishableKey, options) : null;
const adminClient = configured ? createClient(url, secretKey, options) : null;

function createAuthClient() {
  if (!configured) {
    const error = new Error("Supabase Auth is not configured. Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY.");
    error.status = 503;
    throw error;
  }
  return createClient(url, publishableKey, options);
}

function createPkceClient(req, res) {
  if (!configured) {
    const error = new Error("Supabase Auth is not configured. Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY.");
    error.status = 503;
    throw error;
  }

  const cookieOptions = {
    name: pkceStorageKey,
    path: "/",
    maxAge: 600,
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax"
  };
  const requestCookies = getPkceCookies(req);

  return createServerClient(url, publishableKey, {
    cookieOptions,
    auth: { autoRefreshToken: false, detectSessionInUrl: false },
    cookies: {
      getAll() {
        return requestCookies;
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options = {} } of cookiesToSet) {
          if (!pkceCookiePattern.test(name)) continue;
          res.cookie(name, value, {
            ...cookieOptions,
            ...options,
            maxAge: value ? 10 * 60 * 1000 : 0,
            httpOnly: true,
            secure: isProduction,
            sameSite: "lax",
            path: "/"
          });
        }
        for (const [name, value] of Object.entries(headers || {})) res.set(name, value);
      }
    }
  });
}

function hasPendingPkceVerifier(req) {
  return getPkceCookies(req).some(({ name }) => name.endsWith("-code-verifier") && !name.endsWith("-flows-code-verifier"));
}

function clearPkceCookies(req, res) {
  for (const { name } of getPkceCookies(req)) {
    res.clearCookie(name, {
      path: "/",
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax"
    });
  }
}

async function checkConnection() {
  if (!configured) return { configured: false, connected: false };
  const { error } = await adminClient.from("profiles").select("id", { head: true, count: "exact" });
  return { configured: true, connected: !error };
}

module.exports = {
  configured,
  url,
  publicClient,
  adminClient,
  createAuthClient,
  createPkceClient,
  hasPendingPkceVerifier,
  clearPkceCookies,
  frontendUrl,
  backendUrl,
  checkConnection
};
