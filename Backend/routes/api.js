"use strict";

const crypto = require("node:crypto");

function registerApiRoutes(app, dependencies) {
  const {
    db, supabase, bcrypt, ApiError, asyncRoute, publicUser, requireAuth, upload, saveImage,
    importLegacyContent, text, passwordInput, normalizeEmail, normalizeTags,
    normalizeImage, sanitizeContent, blogRow, blogSelect, authLimiter
  } = dependencies;

app.get("/api/health", asyncRoute(async (req, res) => {
  const supabaseStatus = await supabase.checkConnection();
  res.status(supabaseStatus.connected ? 200 : supabaseStatus.configured ? 503 : 200).json({
    status: "ok",
    database: "sqlite",
    supabase: supabaseStatus
  });
}));

app.get("/api/stats", (req, res) => {
  const published = db.prepare("SELECT COUNT(*) AS count FROM blogs WHERE status = 'published'").get().count;
  const creators = db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM blogs WHERE status = 'published'").get().count;
  const subscribers = db.prepare("SELECT COUNT(*) AS count FROM newsletter_subscribers").get().count;
  res.json({ published, creators, subscribers });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId || !req.session.supabaseAccessToken) return res.json({ user: null });
  const user = db.prepare("SELECT id, email, display_name, avatar_path, created_at FROM users WHERE id = ?").get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user: publicUser(user) });
});

function authError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  if (/already registered|already exists|user already registered/i.test(message)) {
    return new ApiError(409, "An account with that email already exists. Log in instead.");
  }
  if (/email not confirmed|email_not_confirmed/i.test(`${message} ${code}`)) {
    return new ApiError(403, "Verify your email address before logging in.");
  }
  if (/expired|invalid.*token|otp.*expired|token.*not found/i.test(message)) {
    return new ApiError(400, "This verification or reset link has expired. Request a new email and try again.");
  }
  if (/invalid login credentials|invalid email or password/i.test(message)) {
    return new ApiError(401, "Email or password is incorrect.");
  }
  return new ApiError(400, "Authentication request could not be completed. Check the details and try again.");
}

async function ensureLocalProfile(authUser, bcrypt) {
  if (!authUser?.email) throw new ApiError(400, "Verified account has no email address.");
  let local = db.prepare("SELECT id, email, display_name, avatar_path, created_at, supabase_user_id FROM users WHERE supabase_user_id = ?").get(authUser.id);
  if (!local) local = db.prepare("SELECT id, email, display_name, avatar_path, created_at, supabase_user_id FROM users WHERE email = ?").get(authUser.email.toLowerCase());
  if (!local) {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString("hex"), 12);
    const name = String(authUser.user_metadata?.full_name || authUser.user_metadata?.name || authUser.email.split("@")[0]).slice(0, 60);
    const result = db.prepare("INSERT INTO users (email, password_hash, display_name, supabase_user_id) VALUES (?, ?, ?, ?)").run(authUser.email.toLowerCase(), passwordHash, name, authUser.id);
    local = db.prepare("SELECT id, email, display_name, avatar_path, created_at FROM users WHERE id = ?").get(result.lastInsertRowid);
  } else if (local.supabase_user_id !== authUser.id) {
    db.prepare("UPDATE users SET supabase_user_id = ? WHERE id = ?").run(authUser.id, local.id);
    local.supabase_user_id = authUser.id;
  }
  return local;
}

function saveAuthSession(req, authSession, localUser) {
  req.session.userId = localUser.id;
  req.session.supabaseAccessToken = authSession.access_token;
  req.session.supabaseRefreshToken = authSession.refresh_token;
  req.session.supabaseExpiresAt = authSession.expires_at || Math.floor(Date.now() / 1000) + (authSession.expires_in || 3600);
}

app.get("/auth/callback", asyncRoute(async (req, res) => {
  const { token_hash: tokenHash, type } = req.query;
  if (typeof tokenHash !== "string" || !["signup", "email", "email_change", "recovery"].includes(type)) {
    return res.redirect(`${supabase.frontendUrl}/login.html?auth_error=invalid_link`);
  }
  let result;
  try {
    result = await supabase.createAuthClient().auth.verifyOtp({ token_hash: tokenHash, type });
  } catch {
    return res.redirect(`${supabase.frontendUrl}/login.html?auth_error=expired_link`);
  }
  if (result.error || !result.data.user || !result.data.session) {
    return res.redirect(`${supabase.frontendUrl}/login.html?auth_error=expired_link`);
  }
  let localUser;
  if (type === "email_change") {
    const linked = db.prepare("SELECT id FROM users WHERE supabase_user_id = ?").get(result.data.user.id);
    if (!linked) return res.redirect(`${supabase.frontendUrl}/login.html?auth_error=invalid_link`);
    db.prepare("UPDATE users SET email = ? WHERE id = ?").run(result.data.user.email.toLowerCase(), linked.id);
    localUser = db.prepare("SELECT id, email, display_name, avatar_path, created_at FROM users WHERE id = ?").get(linked.id);
  } else {
    localUser = await ensureLocalProfile(result.data.user, bcrypt);
  }
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  saveAuthSession(req, result.data.session, localUser);
  res.redirect(`${supabase.frontendUrl}/${type === "recovery" ? "reset-password.html" : "dashboard.html"}`);
}));

app.post("/api/auth/register", authLimiter, asyncRoute(async (req, res) => {
  const name = text(req.body.name, "Name", 60, { required: true });
  const email = normalizeEmail(req.body.email);
  const password = passwordInput(req.body.password, "Password");
  if (password.length < 12) throw new ApiError(400, "Use a password with at least 12 characters.");
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new ApiError(400, "Include at least one lowercase letter, one uppercase letter, and one number.");
  }
  const { data, error } = await supabase.createAuthClient().auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name },
      emailRedirectTo: `${supabase.backendUrl}/auth/callback?type=signup`
    }
  });
  if (error) throw authError(error);
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new ApiError(409, "An account with that email already exists. Log in instead.");
  }
  res.status(202).json({ message: "Check your email and follow the verification link to activate your account.", email: data.user?.email || email });
}));

app.post("/api/auth/login", authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = passwordInput(req.body.password, "Password");
  let result;
  try {
    result = await supabase.createAuthClient().auth.signInWithPassword({ email, password });
  } catch (error) {
    throw authError(error);
  }
  if (result.error) throw authError(result.error);
  if (!result.data.user?.email_confirmed_at || !result.data.session) throw new ApiError(403, "Verify your email address before logging in.");
  const localUser = await ensureLocalProfile(result.data.user, bcrypt);
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  saveAuthSession(req, result.data.session, localUser);
  res.json({ user: publicUser(localUser) });
}));

app.post("/api/auth/forgot-password", authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { error } = await supabase.createAuthClient().auth.resetPasswordForEmail(email, {
    redirectTo: `${supabase.backendUrl}/auth/callback?type=recovery`
  });
  if (error) throw authError(error);
  res.json({ message: "If an account exists for that email, a password reset link has been sent." });
}));

app.post("/api/auth/update-password", requireAuth, asyncRoute(async (req, res) => {
  const password = passwordInput(req.body.password, "Password");
  if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new ApiError(400, "Use at least 12 characters with lowercase, uppercase, and a number.");
  }
  // updateUser requires the Supabase session established by login or recovery.
  if (!req.session.supabaseAccessToken) throw new ApiError(401, "Your password reset session has expired. Request a new reset link.");
  const client = supabase.createAuthClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: req.session.supabaseAccessToken,
    refresh_token: req.session.supabaseRefreshToken
  });
  if (sessionError) throw new ApiError(401, "Your password reset session has expired. Request a new reset link.");
  const updated = await client.auth.updateUser({ password });
  if (updated.error) throw authError(updated.error);
  res.json({ success: true });
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  if (!req.session) return res.json({ success: true });
  if (req.session.supabaseAccessToken && req.session.supabaseRefreshToken && supabase.configured) {
    try {
      const client = supabase.createAuthClient();
      await client.auth.setSession({ access_token: req.session.supabaseAccessToken, refresh_token: req.session.supabaseRefreshToken });
      await client.auth.signOut();
    } catch {
      // Always revoke the local server session, even if the remote token has expired.
    }
  }
  await new Promise((resolve, reject) => {
    req.session.destroy((error) => error ? reject(error) : resolve());
  });
  res.clearCookie("blog.sid", { httpOnly: true, sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", secure: process.env.NODE_ENV === "production" });
  res.json({ success: true });
}));

app.get("/api/profile", requireAuth, (req, res) => {
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts
    FROM blogs WHERE user_id = ?
  `).get(req.user.id);
  res.json({ user: publicUser(req.user), counts });
});

app.patch("/api/profile", requireAuth, asyncRoute(async (req, res) => {
  const name = text(req.body.name, "Name", 60, { required: true });
  const email = normalizeEmail(req.body.email);
  if (email !== req.user.email) {
    const password = passwordInput(req.body.currentPassword, "Current password");
    const client = supabase.createAuthClient();
    const verified = await client.auth.signInWithPassword({ email: req.user.email, password });
    if (verified.error) throw new ApiError(403, "Current password is incorrect.");
    const updated = await client.auth.updateUser({ email }, { emailRedirectTo: `${supabase.backendUrl}/auth/callback?type=email_change` });
    if (updated.error) throw authError(updated.error);
  }
  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, req.user.id);
  res.json({ user: publicUser(db.prepare("SELECT id, email, display_name, avatar_path, created_at FROM users WHERE id = ?").get(req.user.id)) });
}));

app.patch("/api/profile/password", requireAuth, asyncRoute(async (req, res) => {
  const currentPassword = passwordInput(req.body.currentPassword, "Current password");
  const newPassword = passwordInput(req.body.newPassword, "New password");
  if (newPassword.length < 12 || !/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
    throw new ApiError(400, "Use at least 12 characters with lowercase, uppercase, and a number.");
  }
  if (!req.session.supabaseAccessToken || !req.session.supabaseRefreshToken) throw new ApiError(401, "Your session has expired. Please sign in again.");
  const client = supabase.createAuthClient();
  const { error: sessionError } = await client.auth.setSession({ access_token: req.session.supabaseAccessToken, refresh_token: req.session.supabaseRefreshToken });
  if (sessionError) throw new ApiError(401, "Your session has expired. Please sign in again.");
  const verified = await client.auth.signInWithPassword({ email: req.user.email, password: currentPassword });
  if (verified.error) throw new ApiError(403, "Current password is incorrect.");
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) throw authError(error);
  if (verified.data.session) saveAuthSession(req, verified.data.session, req.user);
  res.json({ success: true });
}));

app.post("/api/profile/avatar", requireAuth, upload.single("image"), (req, res, next) => {
  try {
    const avatar = saveImage(req.file);
    if (!avatar) throw new ApiError(400, "Choose an image to upload.");
    db.prepare("UPDATE users SET avatar_path = ? WHERE id = ?").run(avatar, req.user.id);
    res.status(201).json({ avatar });
  } catch (error) {
    next(error);
  }
});

app.get("/api/profile/blogs", requireAuth, (req, res) => {
  const status = ["draft", "published"].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`
    ${blogSelect}
    WHERE b.user_id = ? AND (? IS NULL OR b.status = ?)
    ORDER BY b.updated_at DESC, b.id DESC
  `).all(req.user.id, req.user.id, status, status);
  res.json({ blogs: rows.map((row) => blogRow(row, req.user.id)) });
});

app.post("/api/migrate/local", requireAuth, (req, res, next) => {
  try {
    const sourceBlogs = Array.isArray(req.body.blogs) ? req.body.blogs.slice(0, 100) : [];
    const sourceDraft = req.body.draft && typeof req.body.draft === "object" ? req.body.draft : null;
    const importBlog = db.transaction((source, sourceId, status) => {
      if (db.prepare("SELECT 1 FROM legacy_imports WHERE user_id = ? AND source_id = ?").get(req.user.id, sourceId)) return false;
      const title = text(source.title || "Untitled draft", "Title", 160, { required: true });
      const plain = typeof source.content === "string" ? source.content.slice(0, 1000000) : "";
      const description = text(source.description || plain.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500), "Description", 500);
      const content = importLegacyContent(plain);
      if (status === "published" && !content) return false;
      let coverImage = null;
      if (typeof source.cover === "string" && source.cover.startsWith("data:image/")) {
        const match = source.cover.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (match) {
          const buffer = Buffer.from(match[2], "base64");
          if (buffer.length <= 5 * 1024 * 1024) {
            try {
              coverImage = saveImage({ buffer, mimetype: `image/${match[1]}` });
            } catch {
              coverImage = null;
            }
          }
        }
      } else if (typeof source.cover === "string") {
        coverImage = normalizeImage(source.cover);
      }
      const category = text(source.category, "Category", 80);
      const tags = normalizeTags(source.tags);
      const result = db.prepare(`
        INSERT INTO blogs (user_id, title, description, content, cover_image, category, tags, status, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN datetime('now') ELSE NULL END)
      `).run(req.user.id, title, description, content, coverImage, category, JSON.stringify(tags), status, status);
      db.prepare("INSERT INTO legacy_imports (user_id, source_id, blog_id) VALUES (?, ?, ?)").run(req.user.id, sourceId, result.lastInsertRowid);
      return true;
    });

    let imported = 0;
    sourceBlogs.forEach((blog, index) => {
      if (!blog || typeof blog !== "object") return;
      const sourceId = String(blog.id || `post-${index}`);
      if (importBlog(blog, sourceId, "published")) imported += 1;
    });
    if (sourceDraft) {
      if (importBlog(sourceDraft, "draftBlog", "draft")) imported += 1;
    }
    res.json({ imported });
  } catch (error) {
    next(error);
  }
});

app.get("/api/users/:id", (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return next(new ApiError(400, "Invalid author."));
  const user = db.prepare("SELECT id, display_name, avatar_path, created_at FROM users WHERE id = ?").get(id);
  if (!user) return next(new ApiError(404, "Author not found."));
  res.json({ user: { id: user.id, name: user.display_name, avatar: user.avatar_path, createdAt: user.created_at } });
});

app.get("/api/users/:id/blogs", (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return next(new ApiError(400, "Invalid author."));
  if (!db.prepare("SELECT id FROM users WHERE id = ?").get(id)) return next(new ApiError(404, "Author not found."));
  const rows = db.prepare(`${blogSelect} WHERE b.user_id = ? AND b.status = 'published' ORDER BY b.published_at DESC`).all(req.session.userId || 0, id);
  res.json({ blogs: rows.map((row) => blogRow(row, req.session.userId || null)) });
});

app.post("/api/uploads/images", requireAuth, upload.single("image"), (req, res, next) => {
  try {
    const image = saveImage(req.file);
    if (!image) throw new ApiError(400, "Choose an image to upload.");
    res.status(201).json({ image });
  } catch (error) {
    next(error);
  }
});

app.get("/api/blogs", (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(24, Math.max(1, Number.parseInt(req.query.limit, 10) || 9));
  const query = text(typeof req.query.q === "string" ? req.query.q : "", "Search", 120).toLowerCase();
  const category = text(typeof req.query.category === "string" ? req.query.category : "", "Category", 80);
  const tag = text(typeof req.query.tag === "string" ? req.query.tag : "", "Tag", 32).toLowerCase();
  const sort = ["title-asc", "title-desc"].includes(req.query.sort) ? req.query.sort : req.query.sort === "oldest" ? "oldest" : "newest";
  const orderBy = sort === "title-asc"
    ? "b.title COLLATE NOCASE ASC, b.id ASC"
    : sort === "title-desc"
      ? "b.title COLLATE NOCASE DESC, b.id DESC"
      : `COALESCE(b.published_at, b.created_at) ${sort === "oldest" ? "ASC" : "DESC"}, b.id ${sort === "oldest" ? "ASC" : "DESC"}`;
  const where = ["b.status = 'published'"];
  const values = [];
  if (query) {
    where.push("(lower(b.title) LIKE ? OR lower(b.description) LIKE ? OR lower(b.content) LIKE ? OR lower(b.tags) LIKE ?)");
    const match = `%${query}%`;
    values.push(match, match, match, match);
  }
  if (category) {
    where.push("lower(b.category) = lower(?)");
    values.push(category);
  }
  if (tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(b.tags) WHERE lower(value) = ?)");
    values.push(tag);
  }
  const whereSql = where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) AS count FROM blogs b WHERE ${whereSql}`).get(...values).count;
  const rows = db.prepare(`
    ${blogSelect}
    WHERE ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(req.session.userId || 0, ...values, limit, (page - 1) * limit);
  const categories = db.prepare("SELECT DISTINCT category FROM blogs WHERE status = 'published' AND category != '' ORDER BY category").all().map((row) => row.category);
  const tags = db.prepare("SELECT DISTINCT value AS tag FROM blogs, json_each(blogs.tags) WHERE status = 'published' ORDER BY value").all().map((row) => row.tag);
  res.json({
    blogs: rows.map((row) => blogRow(row, req.session.userId || null)),
    total,
    page,
    pages: Math.ceil(total / limit),
    categories,
    tags
  });
});

app.get("/api/blogs/:id", (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return next(new ApiError(400, "Invalid article."));
  const row = db.prepare(`${blogSelect} WHERE b.id = ? AND b.status = 'published'`).get(req.session.userId || 0, id);
  if (!row) return next(new ApiError(404, "Article not found."));
  const related = db.prepare(`
    ${blogSelect}
    WHERE b.status = 'published' AND b.id != ? AND (b.category = ? OR EXISTS (
      SELECT 1 FROM json_each(b.tags) WHERE value IN (SELECT value FROM json_each(?))
    ))
    ORDER BY b.published_at DESC LIMIT 3
  `).all(req.session.userId || 0, id, row.category, row.tags);
  res.json({ blog: blogRow(row, req.session.userId || null), related: related.map((item) => blogRow(item, req.session.userId || null)) });
});

app.post("/api/blogs", requireAuth, (req, res, next) => {
  try {
    const title = text(req.body.title, "Title", 160, { required: true });
    const description = text(req.body.description, "Description", 500);
    const content = sanitizeContent(req.body.content);
    const coverImage = normalizeImage(req.body.coverImage);
    const category = text(req.body.category, "Category", 80);
    const tags = normalizeTags(req.body.tags);
    const status = req.body.status === "published" ? "published" : "draft";
    if (status === "published" && !content) throw new ApiError(400, "Add content before publishing.");
    const result = db.prepare(`
      INSERT INTO blogs (user_id, title, description, content, cover_image, category, tags, status, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN datetime('now') ELSE NULL END)
    `).run(req.user.id, title, description, content, coverImage || null, category, JSON.stringify(tags), status, status);
    const row = db.prepare(`${blogSelect} WHERE b.id = ?`).get(req.user.id, result.lastInsertRowid);
    res.status(201).json({ blog: blogRow(row, req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/blogs/:id", requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(400, "Invalid article.");
    const existing = db.prepare("SELECT * FROM blogs WHERE id = ?").get(id);
    if (!existing) throw new ApiError(404, "Article not found.");
    if (existing.user_id !== req.user.id) throw new ApiError(403, "You cannot edit this article.");
    const title = text(req.body.title, "Title", 160, { required: true });
    const description = text(req.body.description, "Description", 500);
    const content = sanitizeContent(req.body.content);
    const coverImage = normalizeImage(req.body.coverImage);
    const category = text(req.body.category, "Category", 80);
    const tags = normalizeTags(req.body.tags);
    const status = req.body.status === "published" ? "published" : "draft";
    if (status === "published" && !content) throw new ApiError(400, "Add content before publishing.");
    db.prepare(`
      UPDATE blogs SET title = ?, description = ?, content = ?, cover_image = ?, category = ?, tags = ?,
        status = ?, updated_at = datetime('now'),
        published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, datetime('now')) ELSE NULL END
      WHERE id = ? AND user_id = ?
    `).run(title, description, content, coverImage || null, category, JSON.stringify(tags), status, status, id, req.user.id);
    const row = db.prepare(`${blogSelect} WHERE b.id = ?`).get(req.user.id, id);
    res.json({ blog: blogRow(row, req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/blogs/:id", requireAuth, (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return next(new ApiError(400, "Invalid article."));
  const result = db.prepare("DELETE FROM blogs WHERE id = ? AND user_id = ?").run(id, req.user.id);
  if (!result.changes) return next(new ApiError(404, "Article not found."));
  res.status(204).end();
});

app.post("/api/blogs/:id/like", requireAuth, (req, res, next) => {
  const id = Number(req.params.id);
  const blog = db.prepare("SELECT id FROM blogs WHERE id = ? AND status = 'published'").get(id);
  if (!blog) return next(new ApiError(404, "Article not found."));
  const existing = db.prepare("SELECT 1 FROM likes WHERE user_id = ? AND blog_id = ?").get(req.user.id, id);
  if (existing) db.prepare("DELETE FROM likes WHERE user_id = ? AND blog_id = ?").run(req.user.id, id);
  else db.prepare("INSERT INTO likes (user_id, blog_id) VALUES (?, ?)").run(req.user.id, id);
  const likes = db.prepare("SELECT COUNT(*) AS count FROM likes WHERE blog_id = ?").get(id).count;
  res.json({ liked: !existing, likes });
});

app.get("/api/blogs/:id/comments", (req, res, next) => {
  const id = Number(req.params.id);
  const exists = db.prepare("SELECT id FROM blogs WHERE id = ? AND status = 'published'").get(id);
  if (!exists) return next(new ApiError(404, "Article not found."));
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at, c.updated_at, u.id AS user_id, u.display_name, u.avatar_path
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.blog_id = ? ORDER BY c.created_at DESC
  `).all(id);
  res.json({
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      author: { id: comment.user_id, name: comment.display_name, avatar: comment.avatar_path },
      canEdit: req.session.userId === comment.user_id
    }))
  });
});

app.post("/api/blogs/:id/comments", requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = text(req.body.body, "Comment", 2000, { required: true });
    if (!db.prepare("SELECT id FROM blogs WHERE id = ? AND status = 'published'").get(id)) throw new ApiError(404, "Article not found.");
    const result = db.prepare("INSERT INTO comments (blog_id, user_id, body) VALUES (?, ?, ?)").run(id, req.user.id, body);
    res.status(201).json({
      comment: {
        id: result.lastInsertRowid,
        body,
        createdAt: new Date().toISOString(),
        author: { id: req.user.id, name: req.user.display_name, avatar: req.user.avatar_path },
        canEdit: true
      }
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/comments/:id", requireAuth, (req, res, next) => {
  const id = Number(req.params.id);
  const body = text(req.body.body, "Comment", 2000, { required: true });
  const result = db.prepare("UPDATE comments SET body = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(body, id, req.user.id);
  if (!result.changes) return next(new ApiError(404, "Comment not found."));
  res.json({ id, body });
});

app.delete("/api/comments/:id", requireAuth, (req, res, next) => {
  const result = db.prepare("DELETE FROM comments WHERE id = ? AND user_id = ?").run(Number(req.params.id), req.user.id);
  if (!result.changes) return next(new ApiError(404, "Comment not found."));
  res.status(204).end();
});

app.post("/api/newsletter", (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const name = text(req.body.name, "Name", 60);
    const result = db.prepare("INSERT OR IGNORE INTO newsletter_subscribers (email, name) VALUES (?, ?)").run(email, name);
    if (!result.changes) throw new ApiError(409, "This email is already subscribed.");
    res.status(201).json({ message: "You're subscribed. No email has been sent yet." });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard", requireAuth, (req, res) => {
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts
    FROM blogs WHERE user_id = ?
  `).get(req.user.id);
  const blogs = db.prepare(`${blogSelect} WHERE b.user_id = ? ORDER BY b.updated_at DESC LIMIT 10`).all(req.user.id, req.user.id)
    .map((row) => blogRow(row, req.user.id));
  const subscribers = db.prepare("SELECT COUNT(*) AS count FROM newsletter_subscribers").get().count;
  res.json({ user: publicUser(req.user), counts, blogs, subscribers });
});
}

module.exports = registerApiRoutes;
