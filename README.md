# Stellar Wave Issue Scheduler

A lightweight, real-time web application for reserving issue groups (triplets) across participating repositories:
- `posture-sec/guage` (42 groups)
- `accensa/x402-facilitator-stellar` (42 groups)

## Features
- **Contributor Identification:** Contributor inputs their GitHub handle.
- **Strict Single-Reservation Policy:**
  - One reservation per **username** (case-insensitive).
  - One reservation per **device** (enforced via persistent fingerprint identifier).
  - Atomic reservations backed by SQLite with zero race conditions.
- **Real-Time Sync:** Uses Server-Sent Events (SSE). When any contributor reserves an issue group, all open clients update instantly without a page refresh.
- **Repository Filtering & Search:** Filter by repo, search by issue number or group name, toggle "Available Only".

## Quick Start
```bash
cd scheduler-app
npm install
npm start
```
Access the application at: `http://localhost:3000`
