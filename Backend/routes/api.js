"use strict";

const crypto = require("node:crypto");

function registerApiRoutes(app, dependencies) {
  const {
    db, supabase, bcrypt, ApiError, asyncRoute, publicUser, requireAuth, upload, saveImage,
    importLegacyContent, text, passwordInput, normalizeEmail, normalizeTags,
    normalizeImage, sanitizeContent, blogRow, blogSelect, authLimiter, contentStore
  } = dependencies;
const useSupabaseContent = Boolean(contentStore) && process.env.NODE_ENV !== "test";

function viewerId(req) {
  if (!useSupabaseContent || !req.session?.userId) return null;
  return db.prepare("SELECT supabase_user_id FROM users WHERE id = ?").get(req.session.userId)?.supabase_user_id || null;
}

function validSupabaseId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

app.get("/api/health", asyncRoute(async (req, res) => {
  const supabaseStatus = await supabase.checkConnection();
  res.status(supabaseStatus.connected ? 200 : supabaseStatus.configured ? 503 : 200).json({
    status: "ok",
    database: useSupabaseContent ? "supabase" : "sqlite",
    supabase: supabaseStatus
  });
}));

app.get("/api/stats", asyncRoute(async (req, res) => {
  if (useSupabaseContent) return res.json(await contentStore.getStats());
  const published = db.prepare("SELECT COUNT(*) AS count FROM blogs WHERE status = 'published'").get().count;
  const creators = db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM blogs WHERE status = 'published'").get().count;
  const subscribers = db.prepare("SELECT COUNT(*) AS count FROM newsletter_subscribers").get().count;
  res.json({ published, creators, subscribers });
}));

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
    const avatar = authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture;
    const parsedAvatar = typeof avatar === "string" && URL.canParse(avatar) ? new URL(avatar) : null;
    const avatarUrl = parsedAvatar?.protocol === "https:" && !parsedAvatar.username && !parsedAvatar.password
      ? parsedAvatar.href
      : null;
    const result = db.prepare("INSERT INTO users (email, password_hash, display_name, avatar_path, supabase_user_id) VALUES (?, ?, ?, ?, ?)").run(authUser.email.toLowerCase(), passwordHash, name, avatarUrl, authUser.id);
    local = db.prepare("SELECT id, email, display_name, avatar_path, created_at FROM users WHERE id = ?").get(result.lastInsertRowid);
  } else if (local.supabase_user_id !== authUser.id) {
    if (local.supabase_user_id) throw new ApiError(409, "This email is already linked to a different account.");
    db.prepare("UPDATE users SET supabase_user_id = ? WHERE id = ?").run(authUser.id, local.id);
    local.supabase_user_id = authUser.id;
  }
  if (useSupabaseContent) await contentStore.upsertProfile(authUser);
  return local;
}

function saveAuthSession(req, authSession, localUser) {
  req.session.userId = localUser.id;
  req.session.supabaseAccessToken = authSession.access_token;
  req.session.supabaseRefreshToken = authSession.refresh_token;
  req.session.supabaseExpiresAt = authSession.expires_at || Math.floor(Date.now() / 1000) + (authSession.expires_in || 3600);
}

const PLAN_ORDER = ["free", "premium", "pro", "ultra_vip"];
const PLAN_PRICE_MAP = { free: 0, premium: 500, pro: 999, ultra_vip: 1999 };

function getPlanBySlug(slug) {
  if (!slug || typeof slug !== "string") return null;
  return db.prepare("SELECT * FROM membership_plans WHERE slug = ? AND is_active = 1").get(slug);
}

function getEffectiveMembership(userId) {
  if (!userId) return { plan: getPlanBySlug("free"), unlocked: [], active: false };
  const membership = db.prepare(`
    SELECT um.*, mp.slug AS plan_slug, mp.name AS plan_name, mp.price_inr, mp.description AS plan_description
    FROM user_memberships um
    JOIN membership_plans mp ON mp.id = um.plan_id
    WHERE um.user_id = ?
    ORDER BY datetime(um.activation_date) DESC, um.id DESC
    LIMIT 1
  `).get(userId);
  if (!membership) {
    const freePlan = getPlanBySlug("free");
    return { plan: freePlan, unlocked: [], active: true };
  }
  const expiry = membership.expiry_date ? new Date(membership.expiry_date).getTime() : null;
  const isExpired = expiry !== null && expiry < Date.now();
  if (isExpired && membership.membership_status !== "expired") {
    db.prepare("UPDATE user_memberships SET membership_status = 'expired', updated_at = datetime('now') WHERE id = ?").run(membership.id);
  }
  const current = isExpired ? getPlanBySlug("free") : membership;
  const unlocked = db.prepare(`
    SELECT mf.slug
    FROM plan_features pf
    JOIN membership_features mf ON mf.id = pf.feature_id
    WHERE pf.plan_id = ?
  `).all(current.plan_id || membership.plan_id).map((row) => row.slug);
  return {
    plan: current.plan_id ? { slug: current.plan_slug || membership.plan_slug, name: current.plan_name || membership.plan_name, price_inr: current.price_inr || membership.price_inr, id: current.plan_id || membership.plan_id } : freePlan(),
    unlocked,
    active: !isExpired,
    membership
  };
}

function freePlan() {
  return getPlanBySlug("free");
}

function isFeatureUnlockedForPlan(planSlug, featureSlug) {
  const planOrder = PLAN_ORDER.indexOf(planSlug || "free");
  const featureMinimum = db.prepare("SELECT minimum_plan FROM membership_features WHERE slug = ?").get(featureSlug)?.minimum_plan || "free";
  return PLAN_ORDER.indexOf(featureMinimum) <= planOrder;
}

function ensureAdminAccess(req) {
  const allowed = (process.env.ADMIN_EMAILS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const userEmail = req.user?.email?.toLowerCase();
  if (!userEmail || !allowed.includes(userEmail)) throw new ApiError(403, "Admin access is required.");
}

async function createRazorpayOrder({ userId, planId, amountInr }) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new ApiError(503, "Online payments are not configured yet. No membership has been activated.");
  }
  if (!Number.isInteger(amountInr) || amountInr <= 0) {
    throw new ApiError(400, "The selected plan does not require checkout.");
  }
  const orderId = `draftly_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount: Math.round(amountInr * 100),
      currency: "INR",
      receipt: orderId,
      notes: { userId, planId }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) {
    throw new ApiError(502, payload.error?.description || "Unable to create a Razorpay order right now.");
  }
  return {
    provider: "razorpay",
    orderId: payload.id,
    amount: payload.amount,
    currency: payload.currency,
    receipt: payload.receipt,
    key: keyId,
    success: true,
    mode: "live"
  };
}

function verifyRazorpaySignature({ orderId, paymentId, signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest();
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function activateMembership(userId, planId, options = {}) {
  const { paymentId, orderId, amountPaid = 0, currency = "INR", status = "active" } = options;
  const plan = db.prepare("SELECT * FROM membership_plans WHERE id = ?").get(planId);
  if (!plan) throw new ApiError(400, "Membership plan not found.");
  const expiryDate = new Date(Date.now() + (plan.annual_days || 365) * 24 * 60 * 60 * 1000).toISOString();
  const membership = db.prepare(`
    INSERT INTO user_memberships (user_id, plan_id, payment_id, order_id, activation_date, expiry_date, membership_status, amount_paid, currency, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      payment_id = excluded.payment_id,
      order_id = excluded.order_id,
      activation_date = datetime('now'),
      expiry_date = excluded.expiry_date,
      membership_status = excluded.membership_status,
      amount_paid = excluded.amount_paid,
      currency = excluded.currency,
      updated_at = datetime('now')
  `).run(userId, planId, paymentId || null, orderId || null, expiryDate, status, amountPaid, currency);
  db.prepare("INSERT INTO membership_audit_logs (user_id, plan_id, action, reason, details) VALUES (?, ?, 'activate_membership', ?, ?)").run(userId, planId, "verified_payment", JSON.stringify({ paymentId, orderId, amountPaid }));
  return membership;
}

app.get("/auth/google", asyncRoute(async (req, res) => {
  try {
    const redirectTo = `${supabase.backendUrl}/auth/callback`;
    const { data, error } = await supabase.createPkceClient(req, res).auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo }
    });
    if (error) throw error;
    const authorizeUrl = new URL(data?.url);
    if (!supabase.url || authorizeUrl.origin !== new URL(supabase.url).origin) {
      throw new Error("Supabase returned an unexpected OAuth authorization URL.");
    }
    res.redirect(authorizeUrl.href);
  } catch (error) {
    console.error("Google OAuth initiation failed:", error);
    res.redirect(`${supabase.frontendUrl}/login.html?error=google_failed`);
  }
}));

app.get("/auth/callback", asyncRoute(async (req, res) => {
  const { code, sb_flow_id: flowId, error: providerError, error_description: errorDescription } = req.query;
  if (typeof providerError === "string" && supabase.hasPendingPkceVerifier(req)) {
    console.error("Google OAuth provider callback failed:", {
      error: providerError,
      description: typeof errorDescription === "string" ? errorDescription : undefined
    });
    supabase.clearPkceCookies(req, res);
    return res.redirect(`${supabase.frontendUrl}/login.html?error=google_failed`);
  }
  if (typeof code === "string") {
    try {
      const client = supabase.createPkceClient(req, res);
      const exchangeOptions = typeof flowId === "string" ? { flowId } : undefined;
      const { data, error } = await client.auth.exchangeCodeForSession(code, exchangeOptions);
      if (error) throw error;
      if (!data.user?.email || !data.user.email_confirmed_at || !data.session) {
        throw new Error("Google OAuth did not return a confirmed user session.");
      }
      const localUser = await ensureLocalProfile(data.user, bcrypt);
      await new Promise((resolve, reject) => req.session.regenerate((sessionError) => sessionError ? reject(sessionError) : resolve()));
      saveAuthSession(req, data.session, localUser);
      return res.redirect(`${supabase.frontendUrl}/dashboard.html`);
    } catch (error) {
      console.error("Google OAuth callback failed:", error);
      return res.redirect(`${supabase.frontendUrl}/login.html?error=google_failed`);
    }
  }

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

app.get("/api/profile", requireAuth, asyncRoute(async (req, res) => {
  if (useSupabaseContent) {
    const [profile, counts] = await Promise.all([
      contentStore.getProfile(req.user.supabase_user_id, { privateFields: true }),
      contentStore.getDashboardCounts(req.user.supabase_user_id)
    ]);
    if (!profile) throw new ApiError(404, "Profile not found.");
    return res.json({ user: { id: profile.id, name: profile.full_name, email: profile.email, avatar: profile.avatar_url, createdAt: profile.created_at }, counts });
  }
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts
    FROM blogs WHERE user_id = ?
  `).get(req.user.id);
  res.json({ user: publicUser(req.user), counts });
}));

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
  if (useSupabaseContent) {
    const updatedProfile = await contentStore.updateProfile(req.user.supabase_user_id, { full_name: name });
    return res.json({ user: { id: updatedProfile.id, name: updatedProfile.full_name, email: updatedProfile.email, avatar: updatedProfile.avatar_url, createdAt: updatedProfile.created_at } });
  }
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

app.post("/api/profile/avatar", requireAuth, upload.single("image"), asyncRoute(async (req, res) => {
  try {
    if (useSupabaseContent) {
      const avatar = await contentStore.uploadImage(req.user.supabase_user_id, req.file);
      await contentStore.updateProfile(req.user.supabase_user_id, { avatar_url: avatar });
      db.prepare("UPDATE users SET avatar_path = ? WHERE id = ?").run(avatar, req.user.id);
      return res.status(201).json({ avatar });
    }
    const avatar = saveImage(req.file);
    if (!avatar) throw new ApiError(400, "Choose an image to upload.");
    db.prepare("UPDATE users SET avatar_path = ? WHERE id = ?").run(avatar, req.user.id);
    res.status(201).json({ avatar });
  } catch (error) {
    throw error;
  }
}));

app.get("/api/profile/blogs", requireAuth, asyncRoute(async (req, res) => {
  if (useSupabaseContent) {
    const status = ["draft", "published"].includes(req.query.status) ? req.query.status : undefined;
    const result = await contentStore.listBlogs({ authorId: req.user.supabase_user_id, status, page: 1, limit: 100, sort: "newest", viewerId: req.user.supabase_user_id });
    return res.json({ blogs: result.blogs });
  }
  const status = ["draft", "published"].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`
    ${blogSelect}
    WHERE b.user_id = ? AND (? IS NULL OR b.status = ?)
    ORDER BY b.updated_at DESC, b.id DESC
  `).all(req.user.id, req.user.id, status, status);
  res.json({ blogs: rows.map((row) => blogRow(row, req.user.id)) });
}));

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

app.get("/api/users/:id", asyncRoute(async (req, res, next) => {
  if (useSupabaseContent && validSupabaseId(req.params.id)) {
    const user = await contentStore.getProfile(req.params.id);
    if (!user) return next(new ApiError(404, "Author not found."));
    return res.json({ user: { id: user.id, name: user.full_name, avatar: user.avatar_url, createdAt: user.created_at } });
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return next(new ApiError(400, "Invalid author."));
  const user = db.prepare("SELECT id, display_name, avatar_path, created_at FROM users WHERE id = ?").get(id);
  if (!user) return next(new ApiError(404, "Author not found."));
  res.json({ user: { id: user.id, name: user.display_name, avatar: user.avatar_path, createdAt: user.created_at } });
}));

app.get("/api/users/:id/blogs", asyncRoute(async (req, res, next) => {
  if (useSupabaseContent && validSupabaseId(req.params.id)) {
    const result = await contentStore.listBlogs({ authorId: req.params.id, status: "published", page: 1, limit: 100, sort: "newest", viewerId: viewerId(req) });
    return res.json({ blogs: result.blogs });
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return next(new ApiError(400, "Invalid author."));
  if (!db.prepare("SELECT id FROM users WHERE id = ?").get(id)) return next(new ApiError(404, "Author not found."));
  const rows = db.prepare(`${blogSelect} WHERE b.user_id = ? AND b.status = 'published' ORDER BY b.published_at DESC`).all(req.session.userId || 0, id);
  res.json({ blogs: rows.map((row) => blogRow(row, req.session.userId || null)) });
}));

app.post("/api/uploads/images", requireAuth, upload.single("image"), asyncRoute(async (req, res) => {
  try {
    if (useSupabaseContent) {
      const image = await contentStore.uploadImage(req.user.supabase_user_id, req.file);
      return res.status(201).json({ image });
    }
    const image = saveImage(req.file);
    if (!image) throw new ApiError(400, "Choose an image to upload.");
    res.status(201).json({ image });
  } catch (error) {
    throw error;
  }
}));

app.get("/api/blogs", asyncRoute(async (req, res) => {
  if (useSupabaseContent) {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(24, Math.max(1, Number.parseInt(req.query.limit, 10) || 9));
    const query = text(typeof req.query.q === "string" ? req.query.q : "", "Search", 120).toLowerCase();
    const category = text(typeof req.query.category === "string" ? req.query.category : "", "Category", 80);
    const tag = text(typeof req.query.tag === "string" ? req.query.tag : "", "Tag", 32).toLowerCase();
    const sort = ["title-asc", "title-desc", "oldest"].includes(req.query.sort) ? req.query.sort : "newest";
    return res.json(await contentStore.listBlogs({ page, limit, query, category, tag, sort, viewerId: viewerId(req) }));
  }
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
}));

app.get("/api/blogs/:id", asyncRoute(async (req, res, next) => {
  if (useSupabaseContent && validSupabaseId(req.params.id)) {
    try {
      const blog = await contentStore.getBlog(req.params.id, { publicOnly: true, viewerId: viewerId(req) });
      const related = await contentStore.getRelated(blog);
      return res.json({ blog, related });
    } catch (error) {
      if (error.status === 404) return next(error);
      throw error;
    }
  }
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
}));

app.post("/api/blogs", requireAuth, asyncRoute(async (req, res, next) => {
  try {
    const title = text(req.body.title, "Title", 160, { required: true });
    const description = text(req.body.description, "Description", 500);
    const content = sanitizeContent(req.body.content);
    const coverImage = normalizeImage(req.body.coverImage);
    const category = text(req.body.category, "Category", 80);
    const tags = normalizeTags(req.body.tags);
    const status = req.body.status === "published" ? "published" : "draft";
    if (status === "published" && !content) throw new ApiError(400, "Add content before publishing.");
    if (useSupabaseContent) {
      const blog = await contentStore.saveBlog({ authorId: req.user.supabase_user_id, title, description, content, coverImage, category, tags, status });
      return res.status(201).json({ blog });
    }
    const result = db.prepare(`
      INSERT INTO blogs (user_id, title, description, content, cover_image, category, tags, status, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN datetime('now') ELSE NULL END)
    `).run(req.user.id, title, description, content, coverImage || null, category, JSON.stringify(tags), status, status);
    const row = db.prepare(`${blogSelect} WHERE b.id = ?`).get(req.user.id, result.lastInsertRowid);
    res.status(201).json({ blog: blogRow(row, req.user.id) });
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    throw error;
  }
}));

app.patch("/api/blogs/:id", requireAuth, asyncRoute(async (req, res, next) => {
  try {
    if (useSupabaseContent && validSupabaseId(req.params.id)) {
      const id = req.params.id;
      const title = text(req.body.title, "Title", 160, { required: true });
      const description = text(req.body.description, "Description", 500);
      const content = sanitizeContent(req.body.content);
      const coverImage = normalizeImage(req.body.coverImage);
      const category = text(req.body.category, "Category", 80);
      const tags = normalizeTags(req.body.tags);
      const status = req.body.status === "published" ? "published" : "draft";
      if (status === "published" && !content) throw new ApiError(400, "Add content before publishing.");
      const blog = await contentStore.saveBlog({ id, authorId: req.user.supabase_user_id, title, description, content, coverImage, category, tags, status });
      return res.json({ blog });
    }
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
    if (error instanceof ApiError) return next(error);
    throw error;
  }
}));

app.delete("/api/blogs/:id", requireAuth, asyncRoute(async (req, res, next) => {
  if (useSupabaseContent && validSupabaseId(req.params.id)) {
    await contentStore.deleteBlog(req.params.id, req.user.supabase_user_id);
    return res.status(204).end();
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return next(new ApiError(400, "Invalid article."));
  const result = db.prepare("DELETE FROM blogs WHERE id = ? AND user_id = ?").run(id, req.user.id);
  if (!result.changes) return next(new ApiError(404, "Article not found."));
  res.status(204).end();
}));

app.get("/api/membership/plans", asyncRoute(async (req, res) => {
  const plans = db.prepare(`
    SELECT id, slug, name, price_inr, currency, description, annual_days, recommended
    FROM membership_plans
    WHERE is_active = 1
    ORDER BY price_inr ASC
  `).all();
  res.json({ plans });
}));

app.get("/api/membership/features", asyncRoute(async (req, res) => {
  const features = db.prepare(`
    SELECT slug, name, description, minimum_plan, active, usage_limit, reset_period
    FROM membership_features
    WHERE active = 1
    ORDER BY name ASC
  `).all();
  res.json({ features });
}));

app.get("/api/membership/me", requireAuth, asyncRoute(async (req, res) => {
  const plan = getPlanBySlug("free");
  const membership = db.prepare(`
    SELECT um.*, mp.slug AS plan_slug, mp.name AS plan_name, mp.price_inr, mp.currency
    FROM user_memberships um
    JOIN membership_plans mp ON mp.id = um.plan_id
    WHERE um.user_id = ?
    ORDER BY datetime(um.activation_date) DESC, um.id DESC
    LIMIT 1
  `).get(req.user.id) || null;

  const membershipExpired = membership && (
    membership.membership_status !== "active" ||
    (membership.expiry_date && new Date(membership.expiry_date).getTime() <= Date.now())
  );
  if (membershipExpired && membership.membership_status === "active") {
    db.prepare("UPDATE user_memberships SET membership_status = 'expired', updated_at = datetime('now') WHERE id = ?").run(membership.id);
    membership.membership_status = "expired";
  }
  const currentPlan = membership && !membershipExpired ? getPlanBySlug(membership.plan_slug) || plan : plan;
  const featureSlugs = db.prepare(`
    SELECT mf.slug
    FROM plan_features pf
    JOIN membership_features mf ON mf.id = pf.feature_id
    WHERE pf.plan_id = ?
  `).all(currentPlan.id).map((item) => item.slug);
  const now = Date.now();
  const remainingDays = membership && membership.expiry_date
    ? Math.max(0, Math.ceil((new Date(membership.expiry_date).getTime() - now) / (24 * 60 * 60 * 1000)))
    : 0;

  res.json({
    membership: membership ? {
      id: membership.id,
      plan: membership.plan_slug,
      planName: membership.plan_name,
      status: membership.membership_status,
      activationDate: membership.activation_date,
      expiryDate: membership.expiry_date,
      amountPaid: membership.amount_paid,
      paymentId: membership.payment_id,
      orderId: membership.order_id,
      remainingDays
    } : {
      plan: "free",
      planName: currentPlan.name,
      status: "active",
      activationDate: null,
      expiryDate: null,
      amountPaid: 0,
      paymentId: null,
      orderId: null,
      remainingDays: 365
    },
    plan: { ...currentPlan, features: featureSlugs },
    availableFeatures: featureSlugs,
    featureAccess: featureSlugs
  });
}));

app.get("/api/membership/check", requireAuth, asyncRoute(async (req, res) => {
  const featureId = typeof req.query.feature === "string" ? req.query.feature.trim() : "";
  if (!featureId) {
    return res.json({ feature: null, unlocked: false, requiredPlan: "free" });
  }
  const membership = getEffectiveMembership(req.user.id);
  const unlocked = Boolean(membership.unlocked.includes(featureId) || isFeatureUnlockedForPlan(membership.plan?.slug || "free", featureId));
  const requiredPlan = db.prepare("SELECT minimum_plan FROM membership_features WHERE slug = ?").get(featureId)?.minimum_plan || "free";
  res.json({ feature: featureId, unlocked, requiredPlan, currentPlan: membership.plan?.slug || "free" });
}));

app.post("/api/membership/checkout", requireAuth, asyncRoute(async (req, res) => {
  const planSlug = typeof req.body?.plan === "string" ? req.body.plan.trim() : "";
  const plan = getPlanBySlug(planSlug);
  if (!plan) throw new ApiError(400, "Choose a valid membership plan.");
  const orderPayload = await createRazorpayOrder({ userId: req.user.id, planId: plan.id, amountInr: Number(plan.price_inr || 0) });
  const transaction = db.prepare(`
    INSERT INTO payment_transactions (user_id, plan_id, payment_id, order_id, payment_status, provider, amount, currency, metadata)
    VALUES (?, ?, NULL, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      user_id = excluded.user_id,
      plan_id = excluded.plan_id,
      provider = excluded.provider,
      amount = excluded.amount,
      currency = excluded.currency,
      updated_at = datetime('now')
  `).run(req.user.id, plan.id, orderPayload.orderId, orderPayload.provider || "demo", Number(orderPayload.amount || plan.price_inr * 100) / 100, orderPayload.currency || "INR", JSON.stringify({ plan: plan.slug, amountInr: Number(plan.price_inr || 0) }));
  res.json({
    success: true,
    transactionId: transaction.lastInsertRowid,
    orderId: orderPayload.orderId,
    amount: Number(plan.price_inr || 0),
    currency: orderPayload.currency || "INR",
    provider: orderPayload.provider || "demo",
    key: orderPayload.key || null,
    mode: orderPayload.mode || "demo",
    plan: { slug: plan.slug, name: plan.name, priceInr: Number(plan.price_inr || 0), annualDays: plan.annual_days || 365 }
  });
}));

app.post("/api/membership/verify", requireAuth, asyncRoute(async (req, res) => {
  const planSlug = typeof req.body?.plan === "string" ? req.body.plan.trim() : "";
  const orderId = typeof req.body?.orderId === "string" ? req.body.orderId.trim() : "";
  const paymentId = typeof req.body?.paymentId === "string" ? req.body.paymentId.trim() : "";
  const signature = typeof req.body?.signature === "string" ? req.body.signature.trim() : "";
  const plan = getPlanBySlug(planSlug);
  if (!plan) throw new ApiError(400, "Invalid membership plan.");
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new ApiError(503, "Online payments are not configured. Membership has not been activated.");
  }
  const transaction = db.prepare("SELECT * FROM payment_transactions WHERE user_id = ? AND order_id = ?").get(req.user.id, orderId || "");
  if (!transaction) throw new ApiError(404, "Payment order not found.");
  if (transaction.plan_id !== plan.id || Number(transaction.amount) !== Number(plan.price_inr)) {
    throw new ApiError(400, "The payment order does not match the selected membership plan.");
  }
  if (transaction.payment_status === "paid") {
    const activeMembership = db.prepare("SELECT order_id FROM user_memberships WHERE user_id = ?").get(req.user.id);
    if (activeMembership?.order_id === transaction.order_id) {
      return res.json({ success: true, status: "paid", alreadyVerified: true });
    }
    throw new ApiError(409, "This payment was already processed. Contact support if your membership is not active.");
  }

  const validSignature = verifyRazorpaySignature({ orderId: transaction.order_id, paymentId, signature });
  if (!validSignature) throw new ApiError(400, "Payment signature verification failed.");

  const activateVerifiedPayment = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE payment_transactions
      SET payment_id = ?, payment_status = 'paid', updated_at = datetime('now')
      WHERE id = ? AND payment_status = 'pending'
    `).run(paymentId, transaction.id);
    if (!updated.changes) throw new ApiError(409, "This payment has already been processed.");
    activateMembership(req.user.id, plan.id, {
      paymentId,
      orderId: transaction.order_id,
      amountPaid: Number(plan.price_inr),
      currency: transaction.currency || "INR",
      status: "active"
    });
  });
  activateVerifiedPayment();

  const effectiveMembership = getEffectiveMembership(req.user.id);
  res.json({ success: true, status: "paid", membership: effectiveMembership });
}));

app.get("/api/membership/history", requireAuth, asyncRoute(async (req, res) => {
  const rows = db.prepare(`
    SELECT pt.id, pt.order_id, pt.payment_id, pt.amount, pt.currency, pt.payment_status, p.slug AS plan_slug, p.name AS plan_name, pt.created_at
    FROM payment_transactions pt
    JOIN membership_plans p ON p.id = pt.plan_id
    WHERE pt.user_id = ?
    ORDER BY pt.created_at DESC
  `).all(req.user.id);
  res.json({ transactions: rows });
}));

app.get("/api/membership/admin/plans", requireAuth, asyncRoute(async (req, res) => {
  ensureAdminAccess(req);
  const plans = db.prepare("SELECT * FROM membership_plans WHERE is_active = 1 ORDER BY price_inr ASC").all();
  res.json({ plans });
}));

app.patch("/api/membership/admin/plans/:slug", requireAuth, asyncRoute(async (req, res) => {
  ensureAdminAccess(req);
  const slug = String(req.params.slug || "");
  const plan = getPlanBySlug(slug);
  if (!plan) throw new ApiError(404, "Membership plan not found.");
  const nextPrice = Number(req.body?.priceInr ?? plan.price_inr);
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : plan.description;
  db.prepare("UPDATE membership_plans SET price_inr = ?, description = ?, recommended = ? WHERE slug = ?").run(nextPrice, description, Number(Boolean(req.body?.recommended)) || 0, slug);
  res.json({ success: true, plan: getPlanBySlug(slug) });
}));

app.post("/api/blogs/:id/like", requireAuth, asyncRoute(async (req, res, next) => {  if (useSupabaseContent && validSupabaseId(req.params.id)) {
    return res.json(await contentStore.like(req.params.id, req.user.supabase_user_id));
  }
  const id = Number(req.params.id);
  const blog = db.prepare("SELECT id FROM blogs WHERE id = ? AND status = 'published'").get(id);
  if (!blog) return next(new ApiError(404, "Article not found."));
  const existing = db.prepare("SELECT 1 FROM likes WHERE user_id = ? AND blog_id = ?").get(req.user.id, id);
  if (existing) db.prepare("DELETE FROM likes WHERE user_id = ? AND blog_id = ?").run(req.user.id, id);
  else db.prepare("INSERT INTO likes (user_id, blog_id) VALUES (?, ?)").run(req.user.id, id);
  const likes = db.prepare("SELECT COUNT(*) AS count FROM likes WHERE blog_id = ?").get(id).count;
  res.json({ liked: !existing, likes });
}));

app.get("/api/blogs/:id/comments", asyncRoute(async (req, res, next) => {
  if (useSupabaseContent && validSupabaseId(req.params.id)) {
    const comments = await contentStore.listComments(req.params.id, viewerId(req));
    return res.json({ comments });
  }
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
}));

app.post("/api/blogs/:id/comments", requireAuth, asyncRoute(async (req, res, next) => {
  try {
    if (useSupabaseContent && validSupabaseId(req.params.id)) {
      const body = text(req.body.body, "Comment", 2000, { required: true });
      const comment = await contentStore.addComment(req.params.id, req.user, body);
      return res.status(201).json({ comment });
    }
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
    if (error instanceof ApiError) return next(error);
    throw error;
  }
}));

app.patch("/api/comments/:id", requireAuth, asyncRoute(async (req, res, next) => {
  if (useSupabaseContent && validSupabaseId(req.params.id)) {
    const body = text(req.body.body, "Comment", 2000, { required: true });
    return res.json(await contentStore.editComment(req.params.id, req.user.supabase_user_id, body));
  }
  const id = Number(req.params.id);
  const body = text(req.body.body, "Comment", 2000, { required: true });
  const result = db.prepare("UPDATE comments SET body = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(body, id, req.user.id);
  if (!result.changes) return next(new ApiError(404, "Comment not found."));
  res.json({ id, body });
}));

app.delete("/api/comments/:id", requireAuth, asyncRoute(async (req, res, next) => {
  if (useSupabaseContent && validSupabaseId(req.params.id)) {
    await contentStore.deleteComment(req.params.id, req.user.supabase_user_id);
    return res.status(204).end();
  }
  const result = db.prepare("DELETE FROM comments WHERE id = ? AND user_id = ?").run(Number(req.params.id), req.user.id);
  if (!result.changes) return next(new ApiError(404, "Comment not found."));
  res.status(204).end();
}));

app.post("/api/newsletter", asyncRoute(async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const name = text(req.body.name, "Name", 60);
    if (useSupabaseContent) {
      await contentStore.subscribe(email, name);
      return res.status(201).json({ message: "You're subscribed. No email has been sent yet." });
    }
    const result = db.prepare("INSERT OR IGNORE INTO newsletter_subscribers (email, name) VALUES (?, ?)").run(email, name);
    if (!result.changes) throw new ApiError(409, "This email is already subscribed.");
    res.status(201).json({ message: "You're subscribed. No email has been sent yet." });
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    throw error;
  }
}));

app.get("/api/dashboard", requireAuth, asyncRoute(async (req, res) => {
  if (useSupabaseContent) {
    const [counts, result, stats] = await Promise.all([
      contentStore.getDashboardCounts(req.user.supabase_user_id),
      contentStore.listBlogs({ authorId: req.user.supabase_user_id, page: 1, limit: 10, sort: "newest", viewerId: req.user.supabase_user_id }),
      contentStore.getStats()
    ]);
    return res.json({ user: publicUser(req.user), counts, blogs: result.blogs, subscribers: stats.subscribers });
  }
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
}));

app.use("/api", (req, res, next) => next(new ApiError(404, "API endpoint not found.")));
}

module.exports = registerApiRoutes;
