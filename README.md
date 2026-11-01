# Blogging Platform

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
The production server trusts one proxy hop so `Secure`, `HttpOnly`, `SameSite=Lax`
session cookies work through Render's HTTPS proxy. The server refuses to start if
`SESSION_SECRET` is missing or shorter than 32 characters.

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

The project URL is `https://tsmkeivqvqnyfcmaqbhb.supabase.co`. The CLI prompts for the database password during linking; enter it only in that prompt and do not put it in source, a command argument, or committed files. If it contains reserved characters, the CLI prompt avoids connection-string encoding concerns. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, and `PUBLIC_APP_URL` in Render's private environment settings. `PUBLIC_APP_URL` must be the deployed origin such as `https://your-service.onrender.com`. Keep `SUPABASE_SECRET_KEY` on the backend only. `/api/health` probes whether the Supabase `profiles` relation is queryable after migration.

In Supabase Auth settings, enable email confirmations and set password minimum length to 12 with lowercase, uppercase, and numeric characters required. Add `${PUBLIC_APP_URL}/auth/callback*` to the allowed redirect URLs. Customize both the Confirm signup and Reset Password email templates so their link uses the supplied redirect and token hash, for example:

```html
<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}">Continue</a>
```

The signup redirect includes `type=signup`; the password recovery redirect includes `type=recovery`. The backend callback verifies the one-time token and creates the server session. Without those template and URL settings, confirmation/recovery links will not complete.

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
