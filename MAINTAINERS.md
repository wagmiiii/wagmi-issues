# Maintainer's Operational Guide

This guide explains how to operate, configure, and generate issue groups for the **Issue Scheduler**.

---

## 1. System Architecture & Data Flow

```
[ GitHub Issues ]
        │
        ▼ (scripts/sync_issues.py via `gh` CLI)
┌─────────────────────────┐
│ groups.json             │ ──> Seed file (groups, issue URLs, counts)
│ ISSUES_GROUPED.md       │ ──> Markdown reference table
└─────────────────────────┘
        │
        ▼ (server.js on startup or scripts/reset_db.js)
┌─────────────────────────┐
│ SQLite (scheduler.db)   │ ──> Atomic 1-per-user & 1-per-device reservations
└─────────────────────────┘
        │
        ├──> GET /api/groups        (Returns unbooked groups)
        ├──> POST /api/book         (Claims slot atomically)
        ├──> GET /api/events        (Real-time Server-Sent Events sync)
        └──> GET /api/admin/reservations (Populates Scheduled view)
```

---

## 2. Prerequisites

1. **Node.js 22+** (uses native `node:sqlite`).
2. **Python 3.8+** (for sync script).
3. **GitHub CLI (`gh`)** authenticated with read access to the target repositories:
   ```bash
   gh auth login
   gh auth status
   ```

---

## 3. Step 1: Generating Issue Groups (`sync-issues`)

The generator script requires you to explicitly specify which repositories to target. It **does not** assume or hardcode any default repositories.

### Option A: Interactive Mode (Prompts you for input)
```bash
npm run sync-issues
```
The script will prompt you:
```
=== Repository Input Required ===
Provide the target GitHub repositories (separated by commas or spaces).
Examples: https://github.com/org/repo1, org/repo2
Enter repository URLs or names: https://github.com/my-org/my-repo https://github.com/my-org/another-repo

Enter issue label to filter by (e.g. 'Stellar Wave'): Stellar Wave
```

### Option B: Non-Interactive CLI Arguments
You can pass the repository links/names directly via flags:
```bash
python3 scripts/sync_issues.py \
  --repos https://github.com/posture-sec/guage https://github.com/accensa/x402-facilitator-stellar \
  --label "Stellar Wave" \
  --size 3
```

#### CLI Flags:
* `--repos` *(Required)*: One or more full GitHub URLs or `owner/repo` names.
* `--label` *(Required)*: Issue label to filter by (e.g. `"Stellar Wave"`, `"help wanted"`).
* `--size` *(Optional, default: 3)*: Number of issues per group.
* `--out-json` *(Optional, default: `groups.json`)*: Output path for the server seed file.
* `--out-md` *(Optional, default: `ISSUES_GROUPED.md`)*: Output path for the Markdown reference document.

---

## 4. Step 2: Seeding & Resetting the Database

When `groups.json` is generated or updated, seed it into the database:

```bash
# To populate or reset the database cleanly:
npm run reset-db
```
* Note: `server.js` also inserts missing groups automatically on startup without wiping existing reservations. Use `npm run reset-db` only when you want to start a fresh batch.

---

## 5. Step 3: Running the Application

### Local Development
```bash
npm install
npm start
```
* **Main Contributor App:** `http://localhost:3000`
* **Scheduled Registry (Bookings):** `http://localhost:3000/bookings.html`

### Environment Variables
| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port the HTTP server listens on |
| `DB_PATH` | `./scheduler.db` | Path to persistent SQLite database file |
| `DATABASE_URL` | *(unset)* | PostgreSQL connection string (Neon). When set, Postgres is used instead of SQLite |
| `GITHUB_TOKEN` | *(unset)* | PAT used to read issue assignees/state. Without it, assignment sync is disabled and returns 503 |
| `GITHUB_WEBHOOK_SECRET` | *(unset)* | Shared secret for `POST /api/admin/gh-webhook`. Without it the webhook returns 503 |
| `SYNC_INTERVAL_MS` | `1800000` | Background reconcile period (minimum 60000) |
| `GITHUB_API_BASE` | `https://api.github.com` | Override for local testing only |

---

## 6. Step 4: Monitoring Bookings & Data Export

Maintainers can view live reservations in two ways:

1. **Web Interface:** Navigate to `/bookings.html` (or click **Scheduled** in the top navigation). Includes an **Export CSV** button for reports.
2. **CLI / Terminal:**
   ```bash
   # JSON API:
   curl -s http://localhost:3000/api/admin/reservations | jq .

   # Direct SQLite Query:
   sqlite3 scheduler.db "SELECT * FROM reservations;"
   ```

---

## 6b. Assigned Status & Closed Issues (automatic)

`is_assigned` is **not** read from a static file any more. The server derives it
from GitHub and stores it in the `assigned_users` table:

* A booking counts as **assigned** when the booked contributor is themselves
  among the assignees of at least one of their issues. Issues assigned only to
  someone else do not mark the booker.
* Closed issues **keep counting** as evidence of assignment and are never
  deleted. Their state is stored in `issue_states`, and the registry page marks
  them (struck-through issue number, plus `x/y closed` or `COMPLETED`).
* `completion` on every group is `completed` (all issues closed), `partial`
  (some closed) or `open`. Groups that are fully closed are excluded from the
  *Pending Assignment* metric — finished work is not pending work.
* When a booking's issues are assigned on GitHub to **somebody other than the
  booker**, the row says `TAKEN BY @who` instead of `PENDING` and drops out of
  the pending count. The booking itself is kept (it is a record of what
  happened), but it no longer reads as work waiting to start.

### When does it sync?

1. **On startup**, if `GITHUB_TOKEN` is set.
2. **Every `SYNC_INTERVAL_MS`** (default 30 min) as a reconcile.
3. **On a GitHub webhook** (recommended): repo → Settings → Webhooks → Add:
   * Payload URL: `https://<your-host>/api/admin/gh-webhook`
   * Content type: `application/json`
   * Secret: same value as `GITHUB_WEBHOOK_SECRET`
   * Events: *Issues* and *Issue comments*
4. **Manually:** `curl -X POST https://<your-host>/api/admin/sync-assigned`

A sync only writes when it could actually read GitHub: if every lookup fails, or
more than 10% error, it aborts and keeps the previous state, so a revoked token
or an exhausted rate limit can never wipe the registry.

---

## 7. Step 5: Production Deployment

### Option A: Render.com (1-Click Deployment)
The repository includes a ready-to-use [`render.yaml`](./render.yaml) blueprint:
1. Push this repository to GitHub.
2. Go to **Render Dashboard** → **New +** → **Blueprint** → Select your repository.
3. Render automatically provisions the web service on Node 22 and attaches a persistent disk.

### Option B: Cloudflare Tunnel (Zero-config Public HTTPS)
```bash
# Download cloudflared:
curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared && chmod +x cloudflared

# Launch tunnel:
./cloudflared tunnel --url http://localhost:3000
```
This generates an immediate, high-speed `https://*.trycloudflare.com` URL.
