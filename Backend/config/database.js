"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "blogging-platform.sqlite"));
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    cover_image TEXT,
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blog_id INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, blog_id)
  );

  CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS membership_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    price_inr INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'INR',
    description TEXT NOT NULL DEFAULT '',
    annual_days INTEGER NOT NULL DEFAULT 365,
    is_active INTEGER NOT NULL DEFAULT 1,
    recommended INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS membership_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    minimum_plan TEXT NOT NULL DEFAULT 'free',
    active INTEGER NOT NULL DEFAULT 1,
    usage_limit INTEGER,
    reset_period TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS plan_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES membership_plans(id) ON DELETE CASCADE,
    feature_id INTEGER NOT NULL REFERENCES membership_features(id) ON DELETE CASCADE,
    UNIQUE(plan_id, feature_id)
  );

  CREATE TABLE IF NOT EXISTS user_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES membership_plans(id) ON DELETE RESTRICT,
    payment_id TEXT,
    order_id TEXT,
    activation_date TEXT NOT NULL DEFAULT (datetime('now')),
    expiry_date TEXT,
    membership_status TEXT NOT NULL DEFAULT 'active' CHECK (membership_status IN ('active', 'expired', 'cancelled', 'pending')),
    amount_paid INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'INR',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, order_id)
  );

  CREATE TABLE IF NOT EXISTS payment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES membership_plans(id) ON DELETE RESTRICT,
    payment_id TEXT,
    order_id TEXT NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'cancelled')),
    provider TEXT NOT NULL DEFAULT 'razorpay',
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(order_id)
  );

  CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS membership_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    plan_id INTEGER REFERENCES membership_plans(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    reason TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS legacy_imports (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    blog_id INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, source_id)
  );

  CREATE INDEX IF NOT EXISTS blogs_status_published_idx ON blogs(status, published_at DESC);
  CREATE INDEX IF NOT EXISTS blogs_user_status_idx ON blogs(user_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS comments_blog_created_idx ON comments(blog_id, created_at);
  CREATE INDEX IF NOT EXISTS newsletter_created_idx ON newsletter_subscribers(created_at DESC);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS user_memberships_user_idx ON user_memberships(user_id);
  CREATE INDEX IF NOT EXISTS user_memberships_expiry_idx ON user_memberships(expiry_date);
  CREATE INDEX IF NOT EXISTS payment_transactions_user_idx ON payment_transactions(user_id, created_at DESC);
`);

// Additive link between the existing SQLite author IDs and verified Supabase Auth users.
const userColumns = db.pragma("table_info(users)");
if (!userColumns.some((column) => column.name === "supabase_user_id")) {
  db.exec("ALTER TABLE users ADD COLUMN supabase_user_id TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_user_id_idx ON users(supabase_user_id) WHERE supabase_user_id IS NOT NULL");

const planRows = [
  { slug: "free", name: "Free", price_inr: 0, description: "For new writers getting started.", recommended: 0 },
  { slug: "premium", name: "Premium", price_inr: 500, description: "Unlimited publishing with premium workflows.", recommended: 1 },
  { slug: "pro", name: "Pro", price_inr: 999, description: "SEO and AI growth tools for publishers.", recommended: 0 },
  { slug: "ultra_vip", name: "Ultra VIP", price_inr: 1999, description: "Advanced growth and team publishing at scale.", recommended: 0 }
];

for (const plan of planRows) {
  db.prepare(`
    INSERT OR IGNORE INTO membership_plans (slug, name, price_inr, currency, description, annual_days, is_active, recommended)
    VALUES (?, ?, ?, 'INR', ?, 365, 1, ?)
  `).run(plan.slug, plan.name, plan.price_inr, plan.description, plan.recommended ? 1 : 0);
}

const featureRows = [
  { slug: "basic_editor", name: "Basic editor", minimum_plan: "free" },
  { slug: "publish_blog", name: "Publish blog", minimum_plan: "free" },
  { slug: "personal_dashboard", name: "Personal dashboard", minimum_plan: "free" },
  { slug: "premium_editor", name: "Premium editor", minimum_plan: "premium" },
  { slug: "ai_writing_basic", name: "AI writing basic", minimum_plan: "premium" },
  { slug: "advanced_analytics", name: "Advanced analytics", minimum_plan: "premium" },
  { slug: "scheduled_publishing", name: "Scheduled publishing", minimum_plan: "premium" },
  { slug: "premium_badge", name: "Premium badge", minimum_plan: "premium" },
  { slug: "ad_free", name: "Ad-free experience", minimum_plan: "premium" },
  { slug: "ai_writing_advanced", name: "AI writing advanced", minimum_plan: "pro" },
  { slug: "seo_assistant", name: "SEO assistant", minimum_plan: "pro" },
  { slug: "keyword_suggestions", name: "Keyword suggestions", minimum_plan: "pro" },
  { slug: "newsletter_tools", name: "Newsletter tools", minimum_plan: "pro" },
  { slug: "pdf_export", name: "PDF export", minimum_plan: "pro" },
  { slug: "custom_themes", name: "Custom themes", minimum_plan: "pro" },
  { slug: "ai_writing_high_limits", name: "AI writing high limits", minimum_plan: "ultra_vip" },
  { slug: "custom_domain", name: "Custom domain", minimum_plan: "ultra_vip" },
  { slug: "team_workspace", name: "Team workspace", minimum_plan: "ultra_vip" },
  { slug: "multiple_authors", name: "Multiple authors", minimum_plan: "ultra_vip" },
  { slug: "advanced_team_permissions", name: "Advanced team permissions", minimum_plan: "ultra_vip" },
  { slug: "vip_support", name: "VIP support", minimum_plan: "ultra_vip" },
  { slug: "early_access", name: "Early access", minimum_plan: "ultra_vip" }
];

for (const feature of featureRows) {
  db.prepare(`
    INSERT OR IGNORE INTO membership_features (slug, name, description, minimum_plan, active)
    VALUES (?, ?, ?, ?, 1)
  `).run(feature.slug, feature.name, feature.name, feature.minimum_plan);
}

const planFeatureRows = {
  free: ["basic_editor", "publish_blog", "personal_dashboard"],
  premium: ["basic_editor", "publish_blog", "personal_dashboard", "premium_editor", "ai_writing_basic", "advanced_analytics", "scheduled_publishing", "premium_badge", "ad_free"],
  pro: ["basic_editor", "publish_blog", "personal_dashboard", "premium_editor", "ai_writing_basic", "advanced_analytics", "scheduled_publishing", "premium_badge", "ad_free", "ai_writing_advanced", "seo_assistant", "keyword_suggestions", "newsletter_tools", "pdf_export", "custom_themes"],
  ultra_vip: ["basic_editor", "publish_blog", "personal_dashboard", "premium_editor", "ai_writing_basic", "advanced_analytics", "scheduled_publishing", "premium_badge", "ad_free", "ai_writing_advanced", "seo_assistant", "keyword_suggestions", "newsletter_tools", "pdf_export", "custom_themes", "ai_writing_high_limits", "custom_domain", "team_workspace", "multiple_authors", "advanced_team_permissions", "vip_support", "early_access"]
};

for (const [planSlug, featureSlugs] of Object.entries(planFeatureRows)) {
  const planId = db.prepare("SELECT id FROM membership_plans WHERE slug = ?").get(planSlug)?.id;
  if (!planId) continue;
  for (const featureSlug of featureSlugs) {
    const featureId = db.prepare("SELECT id FROM membership_features WHERE slug = ?").get(featureSlug)?.id;
    if (!featureId) continue;
    db.prepare("INSERT OR IGNORE INTO plan_features (plan_id, feature_id) VALUES (?, ?)").run(planId, featureId);
  }
}

module.exports = db;
