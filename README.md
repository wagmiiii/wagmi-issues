# Stellar Wave Issue Scheduler

A lightweight, real-time web application for reserving issue groups across GitHub repositories with strict **one reservation per username and device** enforcement.

## Features
- **Strict Single-Reservation Policy:**
  - One reservation per **username** (case-insensitive `UNIQUE`).
  - One reservation per **device** (enforced via persistent client fingerprint).
  - Atomic reservations backed by SQLite (`node:sqlite`).
- **Real-Time Sync:** Server-Sent Events (SSE) update all open contributor browsers live when any slot is reserved.
- **Architectural UI:** Minimalist, monochrome, sharp square geometry.
- **Maintainer Tools:** Automated issue sync script, database reset utilities, and CSV export.

---

## Quick Start

```bash
cd scheduler-app
npm install
npm start
```
* App URL: `http://localhost:3000`
* Scheduled Registry: `http://localhost:3000/bookings.html`

---

## For Maintainers

To sync new issues from any repository, configure labels, or reset the database, see the detailed instructions in **[MAINTAINERS.md](./MAINTAINERS.md)**:

```bash
# Sync issues from target repositories (interactively prompts for repo links & label)
npm run sync-issues

# Or pass them directly:
python3 scripts/sync_issues.py --repos https://github.com/owner/repo1 --label "Stellar Wave" --size 3

# Reset reservations and re-seed:
npm run reset-db
```
