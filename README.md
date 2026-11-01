# Draftly

A responsive editorial blogging platform built from the existing HTML, CSS, and vanilla JavaScript site, with an Express API and SQLite persistence.

## Requirements

- Node.js 20 or newer
- npm

## Install and run

```sh
npm install
cp .env.example .env
```

Set `SESSION_SECRET` in `.env` to a random value of at least 32 characters. For example:

```sh
openssl rand -hex 32
```

Never commit `.env`; it is ignored by Git. In Render, add `NODE_ENV=production`
and a stable `SESSION_SECRET` generated with the command above. Render supplies
`PORT` automatically. This app uses SQLite, not `DATABASE_URL`: attach a Render
persistent disk mounted at `/var/data`, then set `DATABASE_PATH=/var/data/blogging-platform.sqlite`
and `UPLOADS_PATH=/var/data/uploads` so both account/content data and uploaded
images survive restarts and deploys. Without the disk, both are on ephemeral
instance storage and can be lost. The SQLite database supports one app instance;
do not scale this service to multiple instances sharing a local disk.

For a Render Web Service use build command `npm ci` and start command `npm start`.
The production server trusts one proxy hop so `Secure`, `HttpOnly`, `SameSite=None`
session cookies work across the Vercel and Render origins. The server refuses to start if
`SESSION_SECRET` is missing or shorter than 32 characters.

## Vercel frontend and Render backend

The repository root is the project root for both services. Render settings are:

- Root Directory: `.`
- Build Command: `npm ci`
- Start Command: `npm start`
- Node.js: `22` (also pinned by `.node-version` and `engines`)
- Health Check Path: `/api/health`

`render.yaml` provides those settings and a `/var/data` persistent disk for the app's current SQLite content, session store, and uploads. The application currently stores blog records and assets in SQLite/filesystem; adding Supabase Auth does not migrate those APIs to Supabase Postgres or Storage. The Render disk is required to preserve those records and sessions until that data layer is migrated. Render assigns `PORT`; the server binds `0.0.0.0`.

Set these Render environment values privately: `NODE_ENV=production`, `DATABASE_PATH=/var/data/blogging-platform.sqlite`, `UPLOADS_PATH=/var/data/uploads`, `SESSION_SECRET` (stable random value at least 32 characters), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `PUBLIC_APP_URL` (the Vercel origin), `BACKEND_PUBLIC_URL` (the Render origin), and `FRONTEND_ORIGIN` (the Vercel origin). Render supplies `PORT`. Do not set secrets in `render.yaml` or commit `.env`.

For Vercel, use Framework Preset **Other**, Root Directory `.`, Install Command `npm ci`, Build Command `npm run build`, and Output Directory `dist`. Set the public build-time variable `FRONTEND_API_URL` to the Render origin, such as `https://your-api.onrender.com`. The Vercel build fails if it is missing or points to localhost. `scripts/build-frontend.js` copies the existing frontend structure to `dist/` and writes the public API origin into `runtime-config.json`; it never includes Supabase keys. The frontend uses credentialed CORS, and `/uploads/...` image URLs are normalized to Render.

The Render service must allow the Vercel origin in `FRONTEND_ORIGIN`. `render.yaml` sets `BACKEND_PUBLIC_URL` to `https://blogging-platform-zkur.onrender.com`; keep it aligned with the service's public origin. Google OAuth and Supabase email redirects use `BACKEND_PUBLIC_URL/auth/callback`; after verification/reset the backend redirects to the Vercel frontend. Configure Supabase Auth's Site URL as the Vercel origin. Cross-site cookies (`SameSite=None; Secure`) are required for separate Vercel and Render domains; browser third-party-cookie blocking may prevent sessions. For the most reliable cookie behavior, use custom Vercel and Render domains under the same registrable domain (for example `app.example.com` and `api.example.com`).

## Supabase schema setup

The repository includes a Supabase CLI project config and an additive SQL migration in `supabase/migrations/`. Signup/login/recovery use Supabase Auth; the backend exchanges email OTP links and keeps access/refresh tokens in its server-side SQLite session store. The existing blog, comment, like, newsletter, and profile APIs still use the SQLite data store. The backend client reads `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` from the server environment; no Supabase key belongs in frontend files.

Install the CLI on macOS with `brew install supabase/tap/supabase`, then:

```sh
supabase login
supabase link --project-ref tsmkeivqvqnyfcmaqbhb
supabase migration list --linked
supabase db pull --linked
```

Review the pulled schema and migration file before changing production. The repo migration creates tables if missing and does not drop tables or records, but an existing table with a conflicting schema needs a reviewed reconciliation migration first. After confirming compatibility, apply and verify with:

```sh
supabase db push --linked
supabase migration list --linked
```

The project URL is `https://tsmkeivqvqnyfcmaqbhb.supabase.co`. The CLI prompts for the database password during linking; enter it only in that prompt and do not put it in source, a command argument, or committed files. If it contains reserved characters, the CLI prompt avoids connection-string encoding concerns. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, `PUBLIC_APP_URL` (Vercel origin), `BACKEND_PUBLIC_URL` (Render origin), and `FRONTEND_ORIGIN` (Vercel origin) in Render's private environment settings. Keep `SUPABASE_SECRET_KEY` on the backend only. `/api/health` probes whether the Supabase `profiles` relation is queryable after migration.

In Supabase Auth settings, enable email confirmations and set password minimum length to 12 with lowercase, uppercase, and numeric characters required. Set Site URL to `PUBLIC_APP_URL` and add `${BACKEND_PUBLIC_URL}/auth/callback*` to the allowed redirect URLs. Customize both the Confirm signup and Reset Password email templates so their link uses the supplied redirect and token hash, for example:

```html
<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}">Continue</a>
```

The signup redirect includes `type=signup`; the password recovery redirect includes `type=recovery`. The backend callback verifies the one-time token and creates the server session. Without those template and URL settings, confirmation/recovery links will not complete.

To enable Google sign-in, open **Authentication → Sign In / Providers → Google** in the Supabase dashboard, enable Google, and enter the Google OAuth client ID and client secret there. Do not add the client secret to this repository or frontend environment. In Google Cloud Console, allow the Supabase project's callback URL (`https://<project-ref>.supabase.co/auth/v1/callback`) as an authorized redirect URI. In Supabase's URL configuration, allow `${BACKEND_PUBLIC_URL}/auth/callback` as a redirect URL. The app starts the PKCE flow on the backend, keeps the short-lived verifier in an HTTP-only cookie, and creates the same server-side session used by email login. No additional application environment variables are required.

Then start the site:

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000). For development with automatic server restarts, run `npm run dev`.

The SQLite database is stored at `Backend/data/blogging-platform.sqlite`; uploaded profile and cover images are stored in `Backend/uploads/`. Both directories are ignored by Git. Back up the database and uploads together. SQLite is appropriate for a single-instance, small deployment; use a managed database and shared session store before running multiple server instances.

The existing application pages are in `Frontend/pages/`, and their shared CSS, JavaScript, and images are in `Frontend/css/`, `Frontend/js/`, and `Frontend/images/`. Frontend API requests use same-origin `/api` endpoints. The Express entry point remains `server.js`; API endpoint registrations are in `Backend/routes/api.js`, database initialization is in `Backend/config/database.js`, and tests are in `Backend/tests/`. Existing page URLs (such as `/index.html` and `/login.html`) and `/api` endpoints remain unchanged.

The existing backend uses parameterized SQLite statements directly rather than an ORM/model layer. Its API handlers remain colocated with route registrations to avoid a behavior-changing rewrite during this filesystem reorganization; the requested `Backend/controllers/` and `Backend/models/` directories are ready for a future incremental extraction.

## Features

- Supabase email registration and verification, login, logout, forgot-password and recovery, with 12+ character upper/lowercase/numeric password rules.
- Persistent server-side SQLite sessions with HTTP-only same-site cookies; Supabase tokens remain server-side. Protected authoring/dashboard/profile routes require a verified Supabase session.
- Duplicate registrations preserve existing accounts and offer a sign-in link. Password reset uses Supabase Auth email delivery and never reveals an existing password.
- Article drafts and publishing with descriptions, categories, tags, sanitized rich text, cover-image upload, inline-image upload, preview, and edit mode.
- Owner-scoped edit, publish/unpublish, and delete actions.
- Public article reading, author profiles, related articles, likes, and comments with author-only edit/delete.
- Database-backed search, category/tag filters, newest/oldest/title sorting, pagination, and empty states.
- Profile name/email editing, profile-image upload, password change, and published-article listing.
- Persisted newsletter subscriptions with validation and duplicate prevention. No email is sent because no email service is configured.
- A one-time, user-confirmed import of old browser-only articles and drafts after signing in. Legacy plaintext credentials are not imported.
- Premium Lemon, Charcoal, and Electric Lavender styling across the existing pages.

## Data and security notes

- Supabase Auth is the source of truth for verified credentials; SQLite mirrors verified user profiles and remains the source of truth for articles, comments, likes, newsletter subscribers, and server-side sessions. Authentication does not trust localStorage.
- Existing localStorage article/draft content can be imported from the sign-in flow. The old localStorage password is discarded; users must register again because it cannot be migrated safely.
- Uploaded images are limited to JPG, PNG, and WebP files up to 5 MB and checked against their file signatures.
- Article HTML is sanitized on the server before it is stored. Profile and comment text is rendered as text.
- Configure HTTPS and a strong `SESSION_SECRET` before deployment. Session cookies are marked `Secure` when `NODE_ENV=production`.
- The app is designed for a trusted single-instance deployment, not as a hardened public multi-tenant SaaS. Add operational monitoring, backups, email verification/recovery, and a production database/session service before broad public use.

## Tests

```sh
npm test
```

The API integration test covers registration and validation, duplicate accounts, persistent sessions, draft/publish/read flows, search filters, content sanitization, likes, comments, newsletter subscriptions, legacy imports, owner authorization, and logout.

## Main pages

- `Frontend/pages/index.html` — landing page and subscription form
- `Frontend/pages/blogs.html` — searchable public article list
- `Frontend/pages/blog.html?id=<id>` — article, likes, comments, and related articles
- `Frontend/pages/editor.html` — protected article authoring and editing
- `Frontend/pages/dashboard.html` — protected article management and account statistics
- `Frontend/pages/profile.html` — public author profile or private account settings
- `Frontend/pages/login.html` and `Frontend/pages/signup.html` — account flows
- `Frontend/pages/legal.html` — privacy, service, and affiliate disclosures
