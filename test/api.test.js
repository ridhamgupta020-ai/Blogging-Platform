"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "blog-platform-test-"));
process.env.DATABASE_PATH = path.join(testDirectory, "test.sqlite");
process.env.UPLOADS_PATH = path.join(testDirectory, "uploads");
process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";

const { app, db } = require("../server");

test("authenticated blog workflows persist and enforce ownership", async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
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
  assert.equal(registration.response.status, 201);
  const ownerCookie = registration.cookie;
  assert.ok(ownerCookie);
  assert.equal(registration.payload.user.email, "riley@example.com");
  assert.equal("password" in registration.payload.user, false);

  const duplicate = await request("auth/register", {
    method: "POST",
    body: { name: "Someone Else", email: "RILEY@example.com", password: "SecurePass1234!" }
  });
  assert.equal(duplicate.response.status, 409);

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
  }, otherUser.cookie);
  assert.equal(forbidden.response.status, 403);

  const commentDelete = await request(`comments/${comment.payload.comment.id}`, { method: "DELETE" }, ownerCookie);
  assert.equal(commentDelete.response.status, 204);
  const deleteBlog = await request(`blogs/${draftId}`, { method: "DELETE" }, ownerCookie);
  assert.equal(deleteBlog.response.status, 204);
  assert.equal((await request("blogs")).payload.total, 1);

  const logout = await request("auth/logout", { method: "POST" }, ownerCookie);
  assert.equal(logout.response.status, 200);
  assert.equal((await request("profile", {}, ownerCookie)).response.status, 401);
});
