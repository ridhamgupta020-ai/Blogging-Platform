"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const helmet = require("helmet");
const multer = require("multer");
const sanitizeHtml = require("sanitize-html");
const db = require("./server/config/database");

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadsDirectory = path.resolve(process.env.UPLOADS_PATH || path.join(__dirname, "uploads"));
const publicPagesDirectory = path.join(__dirname, "public", "pages");
const publicAssetsDirectory = path.join(__dirname, "public", "assets");
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters. Copy .env.example to .env and set a random value.");
}

fs.mkdirSync(uploadsDirectory, { recursive: true });

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare("SELECT sess, expires_at FROM sessions WHERE sid = ?").get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + Number(sess.cookie?.maxAge || 14 * 24 * 60 * 60 * 1000);
      db.prepare(`
        INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(sess), expiresAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    this.set(sid, sess, callback);
  }

  destroy(sid, callback = () => {}) {
    try {
      db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const publicUser = (user) => ({
  id: user.id,
  name: user.display_name,
  email: user.email,
  avatar: user.avatar_path,
  createdAt: user.created_at
});

const currentUser = (req) => {
  if (!req.session.userId) throw new ApiError(401, "Please sign in to continue.");
  const user = db.prepare("SELECT id, email, display_name, avatar_path, created_at FROM users WHERE id = ?").get(req.session.userId);
  if (!user) throw new ApiError(401, "Your session has expired. Please sign in again.");
  return user;
};

const requireAuth = (req, res, next) => {
  try {
    req.user = currentUser(req);
    next();
  } catch (error) {
    next(error);
  }
};

const requireSameOrigin = (req, res, next) => {
  const origin = req.get("origin");
  if (!origin) return next();

  try {
    if (new URL(origin).host !== req.get("host")) {
      return next(new ApiError(403, "Cross-origin requests are not allowed."));
    }
  } catch {
    return next(new ApiError(403, "Invalid request origin."));
  }
  next();
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return callback(new ApiError(415, "Choose a JPG, PNG, or WebP image."));
    }
    callback(null, true);
  }
});

function imageExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return ".jpg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

function saveImage(file) {
  if (!file) return null;
  const extension = imageExtension(file.buffer);
  if (!extension) throw new ApiError(415, "The uploaded file is not a valid JPG, PNG, or WebP image.");
  const filename = `${crypto.randomUUID()}${extension}`;
  fs.writeFileSync(path.join(uploadsDirectory, filename), file.buffer, { flag: "wx" });
  return `/uploads/${filename}`;
}

function importLegacyContent(content) {
  const withUploadedImages = content.replace(
    /src=(["'])data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)\1/gi,
    (match, quote, type, encoded) => {
      try {
        const buffer = Buffer.from(encoded, "base64");
        if (buffer.length > 5 * 1024 * 1024) return 'src=""';
        const image = saveImage({ buffer, mimetype: `image/${type.toLowerCase()}` });
        return `src=${quote}${image}${quote}`;
      } catch {
        return 'src=""';
      }
    }
  );
  return sanitizeContent(withUploadedImages.slice(0, 200000));
}

function text(value, field, maxLength, { required = false } = {}) {
  if (typeof value !== "string") {
    if (required) throw new ApiError(400, `${field} is required.`);
    return "";
  }
  const normalized = value.trim();
  if (required && !normalized) throw new ApiError(400, `${field} is required.`);
  if (normalized.length > maxLength) throw new ApiError(400, `${field} must be ${maxLength} characters or fewer.`);
  return normalized;
}

function passwordInput(value, field) {
  if (typeof value !== "string" || !value.length) throw new ApiError(400, `${field} is required.`);
  if (value.length > 128) throw new ApiError(400, `${field} must be 128 characters or fewer.`);
  return value;
}

function normalizeEmail(value) {
  const email = text(value, "Email", 254, { required: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Enter a valid email address.");
  return email;
}

function normalizeTags(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    .map((tag) => text(tag, "Tag", 32, { required: true }));
}

function normalizeImage(value) {
  const image = text(value, "Image", 300);
  if (!image) return null;
  if (/^\/uploads\/[a-f0-9-]+\.(?:png|jpe?g|webp)$/i.test(image)) return image;
  try {
    const url = new URL(image);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    throw new ApiError(400, "Image must be an uploaded image or a valid HTTP(S) URL.");
  }
  throw new ApiError(400, "Image must be an uploaded image or a valid HTTP(S) URL.");
}

function sanitizeContent(value) {
  const raw = text(value, "Content", 200000);
  if (!raw) return "";
  const content = sanitizeHtml(raw, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "p", "br", "strong", "b", "em", "i", "u", "s",
      "blockquote", "ul", "ol", "li", "a", "img", "figure", "figcaption",
      "pre", "code", "hr", "div", "span"
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      "*": ["class"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" })
    }
  }).trim();
  if (!content) throw new ApiError(400, "Content must include readable text or supported formatting.");
  return content;
}

function blogRow(row, viewerId = null) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    content: row.content,
    coverImage: row.cover_image,
    category: row.category,
    tags: JSON.parse(row.tags || "[]"),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    author: row.author_id ? {
      id: row.author_id,
      name: row.author_name,
      avatar: row.author_avatar
    } : undefined,
    likeCount: row.like_count || 0,
    commentCount: row.comment_count || 0,
    liked: Boolean(viewerId && row.liked_by_viewer)
  };
}

const blogSelect = `
  SELECT b.*,
    u.id AS author_id, u.display_name AS author_name, u.avatar_path AS author_avatar,
    (SELECT COUNT(*) FROM likes l WHERE l.blog_id = b.id) AS like_count,
    (SELECT COUNT(*) FROM comments c WHERE c.blog_id = b.id) AS comment_count,
    EXISTS(SELECT 1 FROM likes l WHERE l.blog_id = b.id AND l.user_id = ?) AS liked_by_viewer
  FROM blogs b
  JOIN users u ON u.id = b.user_id
`;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." }
});

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(requireSameOrigin);
app.use(session({
  name: "blog.sid",
  secret: sessionSecret && sessionSecret.length >= 32 ? sessionSecret : crypto.randomBytes(48).toString("hex"),
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 14 * 24 * 60 * 60 * 1000
  }
}));

app.use("/uploads", express.static(uploadsDirectory, {
  dotfiles: "deny",
  index: false,
  maxAge: "7d",
  immutable: true
}));
app.use((req, res, next) => {
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(req.path);
  } catch {
    return res.sendStatus(400);
  }
  if (
    /(?:^|\/)(?:data|node_modules|\.git)(?:\/|$)/i.test(requestedPath) ||
    /(?:^|\/)(?:server|db)\.js$/i.test(requestedPath) ||
    /(?:^|\/)(?:package(?:-lock)?\.json|README\.md|\.env(?:\..*)?)$/i.test(requestedPath) ||
    /\.(?:sqlite3?|db|log)$/i.test(requestedPath)
  ) {
    return res.sendStatus(404);
  }
  next();
});
app.use("/assets", express.static(publicAssetsDirectory, { dotfiles: "ignore", index: false }));
app.use(express.static(publicPagesDirectory, { dotfiles: "ignore", index: "index.html" }));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/stats", (req, res) => {
  const published = db.prepare("SELECT COUNT(*) AS count FROM blogs WHERE status = 'published'").get().count;
  const creators = db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM blogs WHERE status = 'published'").get().count;
  const subscribers = db.prepare("SELECT COUNT(*) AS count FROM newsletter_subscribers").get().count;
  res.json({ published, creators, subscribers });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.prepare("SELECT id, email, display_name, avatar_path, created_at FROM users WHERE id = ?").get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/register", authLimiter, asyncRoute(async (req, res) => {
  const name = text(req.body.name, "Name", 60, { required: true });
  const email = normalizeEmail(req.body.email);
  const password = passwordInput(req.body.password, "Password");
  if (password.length < 12) throw new ApiError(400, "Use a password with at least 12 characters.");
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new ApiError(400, "Include at least one lowercase letter, one uppercase letter, and one number.");
  }
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
    throw new ApiError(409, "An account with that email already exists.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = db.prepare("INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)").run(email, passwordHash, name);
  await new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
  req.session.userId = Number(result.lastInsertRowid);
  res.status(201).json({
    user: publicUser(db.prepare("SELECT id, email, display_name, avatar_path, created_at FROM users WHERE id = ?").get(result.lastInsertRowid))
  });
}));

app.post("/api/auth/login", authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = passwordInput(req.body.password, "Password");
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new ApiError(401, "Email or password is incorrect.");
  }
  await new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  if (!req.session) return res.json({ success: true });
  await new Promise((resolve, reject) => {
    req.session.destroy((error) => error ? reject(error) : resolve());
  });
  res.clearCookie("blog.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
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
    const credentials = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
    if (!(await bcrypt.compare(password, credentials.password_hash))) throw new ApiError(403, "Current password is incorrect.");
    if (db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, req.user.id)) {
      throw new ApiError(409, "An account with that email already exists.");
    }
  }
  db.prepare("UPDATE users SET display_name = ?, email = ? WHERE id = ?").run(name, email, req.user.id);
  res.json({ user: publicUser(db.prepare("SELECT id, email, display_name, avatar_path, created_at FROM users WHERE id = ?").get(req.user.id)) });
}));

app.patch("/api/profile/password", requireAuth, asyncRoute(async (req, res) => {
  const currentPassword = passwordInput(req.body.currentPassword, "Current password");
  const newPassword = passwordInput(req.body.newPassword, "New password");
  if (newPassword.length < 12 || !/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
    throw new ApiError(400, "Use at least 12 characters with lowercase, uppercase, and a number.");
  }
  const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) throw new ApiError(403, "Current password is incorrect.");
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await bcrypt.hash(newPassword, 12), req.user.id);
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

app.use("/api", (req, res, next) => next(new ApiError(404, "API endpoint not found.")));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof ApiError ? error.status : error.status || 500;
  if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
    return res.status(409).json({ error: "An account with that email already exists." });
  }
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Images must be 5 MB or smaller." });
  }
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? "An unexpected server error occurred." : error.message });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Blogging Platform listening at http://localhost:${port}`);
  });
}

module.exports = { app, db };
