"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "blog-google-auth-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(testDirectory, "test.sqlite");
process.env.UPLOADS_PATH = path.join(testDirectory, "uploads");
process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.SUPABASE_SECRET_KEY = "test-secret-key";
process.env.PUBLIC_APP_URL = "https://app.example.test";
process.env.BACKEND_PUBLIC_URL = "https://api.example.test";

const { app, db } = require("../../server");
const supabase = require("../config/supabase");

test("Google OAuth uses PKCE and creates the existing app session without duplicate profiles", async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  const cookieWrites = [];
  const pkceClient = supabase.createPkceClient(
    { headers: {} },
    {
      cookie(name, value, options) {
        cookieWrites.push({ name, value, options });
      },
      set() {}
    }
  );
  const oauthStart = await pkceClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${process.env.BACKEND_PUBLIC_URL}/auth/callback` }
  });
  assert.equal(oauthStart.error, null);
  assert.equal(new URL(oauthStart.data.url).origin, process.env.SUPABASE_URL);
  const verifierCookie = cookieWrites.find(({ name }) => name.endsWith("-code-verifier") && !name.endsWith("-flows-code-verifier"));
  assert.ok(verifierCookie);
  assert.equal(verifierCookie.options.httpOnly, true);
  assert.equal(verifierCookie.options.secure, false);
  assert.equal(verifierCookie.options.sameSite, "lax");
  assert.ok(verifierCookie.options.maxAge <= 10 * 60 * 1000);
  assert.ok(verifierCookie.options.maxAge > 0);

  const origin = `http://127.0.0.1:${server.address().port}`;
  const googleUser = {
    id: "supabase-google-user",
    email: "riley@example.com",
    email_confirmed_at: new Date().toISOString(),
    user_metadata: {
      full_name: "Riley Writer",
      avatar_url: "https://images.example.test/riley.png"
    }
  };
  const existingUser = {
    id: "supabase-existing-user",
    email: "legacy@example.com",
    email_confirmed_at: new Date().toISOString(),
    user_metadata: { full_name: "New Google Name" }
  };
  const sessions = {
    "new-google-user": googleUser,
    "existing-email-user": existingUser
  };
  let redirectTo;
  let exchangedFlowId;
  let authClientCreated = false;

  supabase.configured = true;
  supabase.url = process.env.SUPABASE_URL;
  supabase.frontendUrl = process.env.PUBLIC_APP_URL;
  supabase.backendUrl = origin;
  supabase.createPkceClient = () => ({
    auth: {
      async signInWithOAuth({ provider, options }) {
        assert.equal(provider, "google");
        redirectTo = options.redirectTo;
        return {
          data: { url: `${process.env.SUPABASE_URL}/auth/v1/authorize?provider=google` },
          error: null
        };
      },
      async exchangeCodeForSession(code, options) {
        exchangedFlowId = options?.flowId;
        if (!sessions[code]) return { data: {}, error: new Error("Invalid authorization code.") };
        return {
          data: {
            user: sessions[code],
            session: {
              access_token: `access-${code}`,
              refresh_token: `refresh-${code}`,
              expires_in: 3600
            }
          },
          error: null
        };
      }
    }
  });
  supabase.createAuthClient = () => {
    authClientCreated = true;
    return { auth: {
      async setSession() { return { error: null }; },
      async signOut() { return { error: null }; }
    } };
  };

  const startResponse = await fetch(`${origin}/auth/google`, { redirect: "manual" });
  assert.equal(startResponse.status, 302);
  assert.equal(startResponse.headers.get("location"), `${process.env.SUPABASE_URL}/auth/v1/authorize?provider=google`);
  assert.equal(redirectTo, `${origin}/auth/callback`);

  const firstLogin = await fetch(`${origin}/auth/callback?code=new-google-user&sb_flow_id=google-flow-1234`, { redirect: "manual" });
  assert.equal(firstLogin.status, 302);
  assert.equal(firstLogin.headers.get("location"), `${process.env.PUBLIC_APP_URL}/dashboard.html`);
  assert.equal(exchangedFlowId, "google-flow-1234");
  let cookie = firstLogin.headers.getSetCookie().find((value) => value.startsWith("blog.sid="))?.split(";")[0];
  assert.ok(cookie);

  const currentUser = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  const currentUserPayload = await currentUser.json();
  assert.equal(currentUserPayload.user.email, "riley@example.com");
  assert.equal(currentUserPayload.user.name, "Riley Writer");
  assert.equal(currentUserPayload.user.avatar, "https://images.example.test/riley.png");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?").get("riley@example.com").count, 1);

  const duplicateLogin = await fetch(`${origin}/auth/callback?code=new-google-user`, { redirect: "manual" });
  assert.equal(duplicateLogin.headers.get("location"), `${process.env.PUBLIC_APP_URL}/dashboard.html`);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?").get("riley@example.com").count, 1);

  const logout = await fetch(`${origin}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie },
    redirect: "manual"
  });
  assert.equal(logout.status, 200);
  assert.equal(authClientCreated, true);
  const loggedOut = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal((await loggedOut.json()).user, null);

  const loginAgain = await fetch(`${origin}/auth/callback?code=new-google-user`, { redirect: "manual" });
  assert.equal(loginAgain.headers.get("location"), `${process.env.PUBLIC_APP_URL}/dashboard.html`);
  cookie = loginAgain.headers.getSetCookie().find((value) => value.startsWith("blog.sid="))?.split(";")[0];
  const restoredUser = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal((await restoredUser.json()).user.email, "riley@example.com");

  const legacyInsert = db.prepare("INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)").run(
    "legacy@example.com",
    "existing-password-hash",
    "Existing Writer"
  );
  const existingEmailLogin = await fetch(`${origin}/auth/callback?code=existing-email-user`, { redirect: "manual" });
  cookie = existingEmailLogin.headers.getSetCookie().find((value) => value.startsWith("blog.sid="))?.split(";")[0];
  assert.equal(existingEmailLogin.headers.get("location"), `${process.env.PUBLIC_APP_URL}/dashboard.html`);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?").get("legacy@example.com").count, 1);
  assert.equal(db.prepare("SELECT id, display_name, supabase_user_id FROM users WHERE id = ?").get(legacyInsert.lastInsertRowid).display_name, "Existing Writer");
  assert.equal(db.prepare("SELECT supabase_user_id FROM users WHERE id = ?").get(legacyInsert.lastInsertRowid).supabase_user_id, "supabase-existing-user");

  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args);
  try {
    const cancelled = await fetch(`${origin}/auth/callback?error=access_denied&error_description=User%20cancelled`, {
      headers: { Cookie: "draftly-google-oauth-code-verifier=test-verifier" },
      redirect: "manual"
    });
    assert.equal(cancelled.headers.get("location"), `${process.env.PUBLIC_APP_URL}/login.html?error=google_failed`);
    const invalidEmailLink = await fetch(`${origin}/auth/callback?error=access_denied&error_code=otp_expired`, { redirect: "manual" });
    assert.equal(invalidEmailLink.headers.get("location"), `${process.env.PUBLIC_APP_URL}/login.html?auth_error=invalid_link`);

    const tampered = await fetch(`${origin}/auth/callback?code=tampered`, { redirect: "manual" });
    assert.equal(tampered.headers.get("location"), `${process.env.PUBLIC_APP_URL}/login.html?error=google_failed`);
    assert.doesNotMatch(tampered.headers.get("location"), /tampered/);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(loggedErrors.length, 2);
  assert.match(String(loggedErrors[1][1]), /Invalid authorization code/);
  assert.doesNotMatch(String(loggedErrors[1][1]), /tampered/);
});
