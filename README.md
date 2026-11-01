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

Then start the site:

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000). For development with automatic server restarts, run `npm run dev`.

The SQLite database is created at `data/blogging-platform.sqlite`; uploaded profile and cover images are stored in `uploads/`. Both directories are ignored by Git and remain at the project root. Back up the database and uploads together. SQLite is appropriate for a single-instance, small deployment; use a managed database and shared session store before running multiple server instances.

The existing application pages are in `public/pages/`, and their shared CSS, JavaScript, and images are in `public/assets/css/`, `public/assets/js/`, and `public/assets/images/`. The Express entry point remains `server.js`; database initialization is in `server/config/database.js`. Tests are in `tests/`. Existing page URLs (such as `/index.html` and `/login.html`) and `/api` endpoints remain unchanged.

## Features

- Registration with normalized unique emails and password rules (12+ characters, upper/lowercase and a number); passwords are bcrypt-hashed.
- Login, logout, persistent server-side SQLite sessions, HTTP-only same-site cookies, and protected authoring/dashboard/profile routes. No demo credentials are configured.
- Article drafts and publishing with descriptions, categories, tags, sanitized rich text, cover-image upload, inline-image upload, preview, and edit mode.
- Owner-scoped edit, publish/unpublish, and delete actions.
- Public article reading, author profiles, related articles, likes, and comments with author-only edit/delete.
- Database-backed search, category/tag filters, newest/oldest/title sorting, pagination, and empty states.
- Profile name/email editing, profile-image upload, password change, and published-article listing.
- Persisted newsletter subscriptions with validation and duplicate prevention. No email is sent because no email service is configured.
- A one-time, user-confirmed import of old browser-only articles and drafts after signing in. Legacy plaintext credentials are not imported.
- Premium Lemon, Charcoal, and Electric Lavender styling across the existing pages.

## Data and security notes

- SQLite is the source of truth for accounts, articles, comments, likes, newsletter subscribers, and sessions. Authentication does not trust localStorage.
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

- `public/pages/index.html` — landing page and subscription form
- `public/pages/blogs.html` — searchable public article list
- `public/pages/blog.html?id=<id>` — article, likes, comments, and related articles
- `public/pages/editor.html` — protected article authoring and editing
- `public/pages/dashboard.html` — protected article management and account statistics
- `public/pages/profile.html` — public author profile or private account settings
- `public/pages/login.html` and `public/pages/signup.html` — account flows
- `public/pages/legal.html` — privacy, service, and affiliate disclosures
