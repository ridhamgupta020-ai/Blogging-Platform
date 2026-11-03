"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "blog-platform-test-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(testDirectory, "test.sqlite");
process.env.UPLOADS_PATH = path.join(testDirectory, "uploads");
process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.SUPABASE_SECRET_KEY = "test-secret-key";
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

const { app, db } = require("../../server");
const supabase = require("../config/supabase");

test("authenticated blog workflows persist and enforce ownership", async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const usersByEmail = new Map();
  const usersByVerificationToken = new Map();
  function createAuthSession(user) {
    return {
      access_token: `access-${user.id}`,
      refresh_token: `refresh-${user.id}`,
      expires_in: 3600
    };
  }
  supabase.configured = true;
  supabase.createAuthClient = () => ({
    auth: {
      async signUp({ email, password, options }) {
        if (usersByEmail.has(email)) {
          return { data: { user: { email, identities: [] }, session: null }, error: null };
        }
        const user = {
          id: `supabase-${email}`,
          email,
          email_confirmed_at: null,
          user_metadata: options.data,
          password
        };
        usersByEmail.set(email, user);
        usersByVerificationToken.set(`confirm-${email}`, user);
        return { data: { user: { ...user, identities: [{}] }, session: null }, error: null };
      },
      async verifyOtp({ token_hash: tokenHash }) {
        const user = usersByVerificationToken.get(tokenHash);
        if (!user) return { data: {}, error: new Error("Token not found.") };
        const verifiedUser = { ...user, email_confirmed_at: new Date().toISOString() };
        usersByEmail.set(user.email, verifiedUser);
        return { data: { user: verifiedUser, session: createAuthSession(verifiedUser) }, error: null };
      },
      async signInWithPassword({ email, password }) {
        const user = usersByEmail.get(email);
        if (!user || user.password !== password) {
          return { data: {}, error: new Error("Invalid login credentials") };
        }
        return { data: { user, session: createAuthSession(user) }, error: null };
      },
      async setSession() {
        return { data: { session: null }, error: null };
      },
      async signOut() {
        return { error: null };
      }
    }
  });

  async function request(url, options = {}, cookie) {
    const headers = new Headers(options.headers || {});
    if (cookie) headers.set("Cookie", cookie);
    if (options.body && typeof options.body !== "string" && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
      options = { ...options, body: JSON.stringify(options.body) };
    }
    const response = await fetch(`${origin}/api/${url}`, { ...options, headers });
    const cookies = response.headers.getSetCookie();
    const nextCookie = cookies.length ? cookies[0].split(";")[0] : cookie;
    const payload = response.status === 204 ? null : await response.json();
    return { response, payload, cookie: nextCookie };
  }

  const registration = await request("auth/register", {
    method: "POST",
    body: { name: "Riley Writer", email: "riley@example.com", password: "SecurePass1234!" }
  });
  assert.equal(registration.response.status, 202);
  assert.equal(registration.payload.email, "riley@example.com");
  const verification = await fetch(`${origin}/auth/callback?token_hash=confirm-riley%40example.com&type=signup`, { redirect: "manual" });
  assert.equal(verification.status, 302);
  assert.equal(verification.headers.get("location"), `${supabase.frontendUrl}/dashboard.html`);
  const ownerCookie = verification.headers.getSetCookie().find((value) => value.startsWith("blog.sid="))?.split(";")[0];
  assert.ok(ownerCookie);
  assert.equal(db.prepare("SELECT email FROM users WHERE email = ?").get("riley@example.com").email, "riley@example.com");
  const registeredUser = (await request("auth/me", {}, ownerCookie)).payload.user;
  assert.equal(registeredUser.email, "riley@example.com");
  assert.equal("password" in registeredUser, false);
  const membershipPlans = await request("membership/plans");
  assert.equal(membershipPlans.response.status, 200);
  assert.deepEqual(membershipPlans.payload.plans.map((plan) => [plan.slug, plan.price_inr, plan.annual_days]), [
    ["free", 0, 365],
    ["premium", 500, 365],
    ["pro", 999, 365],
    ["ultra_vip", 1999, 365]
  ]);
  const currentMembership = await request("membership/me", {}, ownerCookie);
  assert.equal(currentMembership.response.status, 200);
  assert.equal(currentMembership.payload.membership.plan, "free");
  const unavailableCheckout = await request("membership/checkout", {
    method: "POST",
    body: { plan: "premium" }
  }, ownerCookie);
  assert.equal(unavailableCheckout.response.status, 503);
  assert.match(unavailableCheckout.payload.error, /not configured/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_memberships WHERE user_id = ?").get(registeredUser.id).count, 0);
  const unavailableVerification = await request("membership/verify", {
    method: "POST",
    body: { plan: "premium", orderId: "fake-order", paymentId: "fake-payment", signature: "fake-signature" }
  }, ownerCookie);
  assert.equal(unavailableVerification.response.status, 503);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_memberships WHERE user_id = ?").get(registeredUser.id).count, 0);
  const premiumPlanId = db.prepare("SELECT id FROM membership_plans WHERE slug = 'premium'").get().id;
  db.prepare(`
    INSERT INTO user_memberships (user_id, plan_id, activation_date, expiry_date, membership_status, amount_paid)
    VALUES (?, ?, datetime('now', '-400 days'), datetime('now', '-35 days'), 'active', 500)
  `).run(registeredUser.id, premiumPlanId);
  const expiredMembership = await request("membership/me", {}, ownerCookie);
  assert.equal(expiredMembership.response.status, 200);
  assert.equal(expiredMembership.payload.membership.status, "expired");
  assert.equal(expiredMembership.payload.plan.slug, "free");
  assert.deepEqual(expiredMembership.payload.availableFeatures.sort(), ["basic_editor", "personal_dashboard", "publish_blog"]);
  assert.equal((await request("dashboard")).response.status, 401);
  assert.equal((await request("auth/me")).payload.user, null);

  const imageForm = new FormData();
  imageForm.append("image", new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], { type: "image/jpeg" }), "cover.jpg");
  const imageUpload = await request("uploads/images", { method: "POST", body: imageForm }, ownerCookie);
  assert.equal(imageUpload.response.status, 201);
  assert.match(imageUpload.payload.image, /^\/uploads\/[a-f0-9-]+\.jpg$/);
  const storedImage = await fetch(`${origin}${imageUpload.payload.image}`);
  assert.equal(storedImage.status, 200);
  assert.equal(storedImage.headers.get("content-type"), "image/jpeg");

  const duplicate = await request("auth/register", {
    method: "POST",
    body: { name: "Someone Else", email: "RILEY@example.com", password: "SecurePass1234!" }
  });
  assert.equal(duplicate.response.status, 409);
  assert.match(duplicate.payload.error, /already exists/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  assert.equal(db.prepare("SELECT display_name FROM users WHERE email = ?").get("riley@example.com").display_name, "Riley Writer");

  const incorrectPassword = await request("auth/login", {
    method: "POST",
    body: { email: "riley@example.com", password: "IncorrectPass123!" }
  });
  assert.equal(incorrectPassword.response.status, 401);

  const unknownAccount = await request("auth/login", {
    method: "POST",
    body: { email: "missing@example.com", password: "IncorrectPass123!" }
  });
  assert.equal(unknownAccount.response.status, 401);
  assert.equal(unknownAccount.payload.error, incorrectPassword.payload.error);

  const login = await request("auth/login", {
    method: "POST",
    body: { email: "RILEY@example.com", password: "SecurePass1234!" }
  });
  assert.equal(login.response.status, 200);
  assert.ok(login.cookie);
  assert.equal(login.payload.user.id, registeredUser.id);
  assert.equal((await request("auth/me", {}, login.cookie)).payload.user.email, "riley@example.com");
  assert.equal((await request("dashboard", {}, login.cookie)).response.status, 200);

  const weakPassword = await request("auth/register", {
    method: "POST",
    body: { name: "Weak Writer", email: "weak@example.com", password: "short" }
  });
  assert.equal(weakPassword.response.status, 400);

  const draft = await request("blogs", {
    method: "POST",
    body: {
      title: "Persistent draft",
      description: "A draft saved to SQLite.",
      content: "<p>Not public yet.</p>",
      category: "Engineering",
      tags: ["SQLite", "Testing"],
      status: "draft"
    }
  }, ownerCookie);
  assert.equal(draft.response.status, 201);
  const draftId = draft.payload.blog.id;
  assert.equal(draft.payload.blog.status, "draft");
  assert.equal((await request("blogs")).payload.total, 0);

  const publish = await request(`blogs/${draftId}`, {
    method: "PATCH",
    body: {
      title: "Persistent draft",
      description: "A published SQLite article.",
      content: "<p>Hello readers.</p><script>window.__xss = true</script><img src=x onerror=alert(1)>",
      category: "Engineering",
      tags: ["sqlite", "testing"],
      status: "published"
    }
  }, ownerCookie);
  assert.equal(publish.response.status, 200);
  assert.equal(publish.payload.blog.status, "published");
  assert.doesNotMatch(publish.payload.blog.content, /<script|onerror=/i);

  const filtered = await request("blogs?q=sqlite&category=Engineering&tag=testing&sort=newest");
  assert.equal(filtered.payload.total, 1);
  assert.equal(filtered.payload.blogs[0].id, draftId);

  const detail = await request(`blogs/${draftId}`);
  assert.equal(detail.payload.blog.author.name, "Riley Writer");
  assert.equal(detail.payload.blog.likeCount, 0);

  const comment = await request(`blogs/${draftId}/comments`, {
    method: "POST",
    body: { body: "<img src=x onerror=alert(1)>A useful comment." }
  }, ownerCookie);
  assert.equal(comment.response.status, 201);
  assert.equal(comment.payload.comment.body, "<img src=x onerror=alert(1)>A useful comment.");

  const editedComment = await request(`comments/${comment.payload.comment.id}`, {
    method: "PATCH",
    body: { body: "Edited comment." }
  }, ownerCookie);
  assert.equal(editedComment.payload.body, "Edited comment.");

  const like = await request(`blogs/${draftId}/like`, { method: "POST" }, ownerCookie);
  assert.deepEqual(like.payload, { liked: true, likes: 1 });
  const unlike = await request(`blogs/${draftId}/like`, { method: "POST" }, ownerCookie);
  assert.deepEqual(unlike.payload, { liked: false, likes: 0 });

  const newsletter = await request("newsletter", {
    method: "POST",
    body: { email: "reader@example.com", name: "Reader" }
  });
  assert.equal(newsletter.response.status, 201);
  assert.equal((await request("newsletter", {
    method: "POST",
    body: { email: "reader@example.com" }
  })).response.status, 409);

  const migrated = await request("migrate/local", {
    method: "POST",
    body: {
      blogs: [{ id: 33, title: "Legacy article", content: "<p>Imported once.</p>", tags: ["legacy"] }],
      draft: { title: "Legacy draft", content: "<p>Still private.</p>" }
    }
  }, ownerCookie);
  assert.equal(migrated.payload.imported, 2);
  const repeatImport = await request("migrate/local", {
    method: "POST",
    body: { blogs: [{ id: 33, title: "Legacy article", content: "<p>Imported once.</p>" }] }
  }, ownerCookie);
  assert.equal(repeatImport.payload.imported, 0);

  const profile = await request("profile", {}, ownerCookie);
  assert.equal(profile.payload.counts.total, 3);
  assert.equal(profile.payload.counts.published, 2);
  assert.equal(profile.payload.counts.drafts, 1);

  const unauthorized = await request(`blogs/${draftId}`, { method: "DELETE" });
  assert.equal(unauthorized.response.status, 401);
  const otherUser = await request("auth/register", {
    method: "POST",
    body: { name: "Other Writer", email: "other@example.com", password: "AnotherSecure123!" }
  });
  assert.equal(otherUser.response.status, 202);
  const otherVerification = await fetch(`${origin}/auth/callback?token_hash=confirm-other%40example.com&type=signup`, { redirect: "manual" });
  const otherUserCookie = otherVerification.headers.getSetCookie().find((value) => value.startsWith("blog.sid="))?.split(";")[0];
  const forbidden = await request(`blogs/${draftId}`, {
    method: "PATCH",
    body: {
      title: "Takeover",
      description: "",
      content: "<p>Not yours.</p>",
      category: "",
      tags: [],
      status: "published"
    }
  }, otherUserCookie);
  assert.equal(forbidden.response.status, 403);

  const commentDelete = await request(`comments/${comment.payload.comment.id}`, { method: "DELETE" }, ownerCookie);
  assert.equal(commentDelete.response.status, 204);
  const deleteBlog = await request(`blogs/${draftId}`, { method: "DELETE" }, ownerCookie);
  assert.equal(deleteBlog.response.status, 204);
  assert.equal((await request("blogs")).payload.total, 1);

  const logout = await request("auth/logout", { method: "POST" }, ownerCookie);
  assert.equal(logout.response.status, 200);
  assert.equal((await request("profile", {}, ownerCookie)).response.status, 401);
  assert.equal((await request("auth/me", {}, ownerCookie)).payload.user, null);
  assert.equal((await request("dashboard", {}, ownerCookie)).response.status, 401);
});
