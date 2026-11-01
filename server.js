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
const db = require("./Backend/config/database");
const registerApiRoutes = require("./Backend/routes/api");

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadsDirectory = path.resolve(process.env.UPLOADS_PATH || path.join(__dirname, "Backend", "uploads"));
const frontendDirectory = path.join(__dirname, "Frontend");
const publicPagesDirectory = path.join(frontendDirectory, "pages");
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
for (const assetType of ["css", "js", "images"]) {
  app.use(`/${assetType}`, express.static(path.join(frontendDirectory, assetType), { dotfiles: "ignore", index: false }));
}
app.use(express.static(publicPagesDirectory, { dotfiles: "ignore", index: "index.html" }));

registerApiRoutes(app, {
  db, bcrypt, ApiError, asyncRoute, publicUser, requireAuth, upload, saveImage,
  importLegacyContent, text, passwordInput, normalizeEmail, normalizeTags,
  normalizeImage, sanitizeContent, blogRow, blogSelect, authLimiter
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
