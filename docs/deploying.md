# Deploying GroupMind to a hosted platform

> **This is an operator runbook, not a starting point.** If you just want to run
> GroupMind, do not read this file - use the one-line install in the
> [README](../README.md), which needs no account with any service. This page is
> for putting an instance on someone else's infrastructure.

Both paths below need a Postgres with the schema applied. **Apply every
migration in `supabase/migrations/`, in filename order - all 19 of them.** There
is no single file that creates the database: `001_initial_schema.sql` on its own
produces a schema the app cannot run against, because the chat core (`rooms`,
`room_members`, `messages`) is created in `003_core_tables.sql` and seven later
migrations alter tables that do not exist yet. `selfhost/migrate.sh` applies
them in order, and `npm run schema:check` verifies the chain against a throwaway
Postgres before you touch a real one.

---

## Hosted Supabase + Vercel

### 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Apply the migrations. **All of them, in filename order** - see the note at
   the top of this page. The practical way is `selfhost/migrate.sh` pointed at
   the project's connection string; pasting one file into the SQL Editor
   produces a database the app cannot run against.
3. Get your credentials from Project Settings → API:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`

### 2. Deploy to Vercel

1. Push to GitHub:
```bash
gh repo create groupmind --public --source=. --push
# or
git remote add origin git@github.com:YOUR_USERNAME/groupmind.git
git push -u origin main
```

2. Go to [vercel.com](https://vercel.com) → Import Project → Select your GitHub repo

3. Add environment variables in Vercel:
   - `NEXT_PUBLIC_SUPABASE_URL` = your Supabase URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your Supabase anon key
   - `NEXT_PUBLIC_BASE_URL` = https://groupmind.one

4. Deploy!

### 3. Configure Domain

In Vercel project settings → Domains → Add `groupmind.one`

### 4. Deploy Docker to Google Cloud Run

1. Ensure you have the Google Cloud SDK installed and authenticated.
2. Build the Docker image:
```bash
# From the project root
docker build -t gcr.io/PROJECT_ID/groupmind:latest .
```
3. Push the image to Artifact Registry:
```bash
gcloud builds submit --tag gcr.io/PROJECT_ID/groupmind:latest
```
4. Deploy to Cloud Run:
```bash
gcloud run deploy groupmind \
  --image gcr.io/PROJECT_ID/groupmind:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080
```
5. Set the same environment variables in Cloud Run (Settings → Variables & Secrets).

### 5. Configure Domain (Cloud Run)

1. In Cloud Run service details, click **Manage custom domains**.
2. Add your domain and verify ownership via your DNS provider.
3. Map the domain to the Cloud Run service.

## Admin Dashboard (`/admin`)

Unified multi-app admin: `/admin` shows one card per ThinkOff app with headline
numbers; click a card to dive in (`/admin/codewatch` = full local dashboard,
remote apps get a generic stats view). Apps are registered in
`src/lib/admin-apps.ts`  -  adding an app is one registry entry.

Environment variables:

- `ADMIN_DASHBOARD_PASSWORD` (required to enable the gate)  -  **must be at
  least 32 random characters** (generate with `openssl rand -base64 32`).
  The gate refuses to enable itself for values shorter than 32 characters.
  One shared password, so treat it like a service credential and rotate it
  when anyone loses access rights. Sessions are signed server-side and expire
  after 7 days; rotating the password invalidates all sessions. Failed logins
  are rate limited across all serverless instances through the
  `admin_login_failures` table  -  apply
  `supabase/migrations/20260713_admin_login_failures.sql` before enabling the
  gate (the limiter fails closed if the table is unreachable).
- `THINKOFF_STATS_URL` (optional)  -  stats endpoint for the ThinkOff App card.
  Until it is set the card shows an "awaiting stats endpoint" state.
- `THINKOFF_STATS_SECRET` (optional)  -  sent to that endpoint as the
  `X-Admin-Stats-Secret` header; the endpoint must verify it.

Remote stats endpoints implement the small JSON contract documented at the
top of `src/lib/admin-apps.ts` (headline tiles + optional label/value
sections, no PII).

