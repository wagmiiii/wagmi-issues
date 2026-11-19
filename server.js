const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const seedData = JSON.parse(fs.readFileSync(path.join(__dirname, 'groups.json'), 'utf8'));

// Assigned contributors live in the database (table: assigned_users) and are
// refreshed from GitHub by POST /api/admin/sync-assigned. The committed JSON
// file is only a one-time seed for databases created before that table existed.
const ASSIGNED_TTL_MS = 30 * 1000;

function readAssignedSeed() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'assigned_users.json'), 'utf8'));
    return list.map(u => String(u).trim().toLowerCase()).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// Database Adapter (PostgreSQL if DATABASE_URL is set, else SQLite)
let dbAdapter;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  dbAdapter = {
    type: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS groups (
          id TEXT PRIMARY KEY,
          group_name TEXT NOT NULL,
          repo TEXT NOT NULL,
          repo_short TEXT NOT NULL,
          issues_json TEXT NOT NULL,
          count INTEGER NOT NULL,
          booked_by TEXT DEFAULT NULL,
          booked_at TEXT DEFAULT NULL,
          device_id TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS reservations (
          id SERIAL PRIMARY KEY,
          group_id TEXT NOT NULL UNIQUE REFERENCES groups(id),
          username TEXT NOT NULL,
          device_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_res_user_lower ON reservations (LOWER(username));

        CREATE TABLE IF NOT EXISTS assigned_users (
          username TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'github',
          updated_at TEXT NOT NULL
        );

        -- Open/closed state of every grouped issue, refreshed from GitHub.
        -- Closed issues are kept forever: closing is the outcome we want, and
        -- a group's history must not disappear once it is completed.
        CREATE TABLE IF NOT EXISTS issue_states (
          repo TEXT NOT NULL,
          number INTEGER NOT NULL,
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (repo, number)
        );
      `);

      // Seed missing groups if needed
      const countRes = await pool.query('SELECT COUNT(*) FROM groups');
      if (parseInt(countRes.rows[0].count) < seedData.length) {
        for (const item of seedData) {
          await pool.query(
            `INSERT INTO groups (id, group_name, repo, repo_short, issues_json, count)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO NOTHING`,
            [item.id, item.group_name, item.repo, item.repo_short, JSON.stringify(item.issues), item.count]
          );
        }
      }
      const assignedCount = await pool.query('SELECT COUNT(*) FROM assigned_users');
      if (parseInt(assignedCount.rows[0].count, 10) === 0) {
        const seededAt = new Date().toISOString();
        for (const u of readAssignedSeed()) {
          await pool.query(
            `INSERT INTO assigned_users (username, source, updated_at) VALUES ($1, 'seed', $2)
             ON CONFLICT (username) DO NOTHING`,
            [u, seededAt]
          );
        }
        console.log(`Seeded ${readAssignedSeed().length} assigned usernames from assigned_users.json`);
      }
      console.log('Connected to PostgreSQL (Neon). Seed verification complete.');
    },

    _assigned: null,
    _assignedAt: 0,

    async getAssignedSet() {
      const now = Date.now();
      if (this._assigned && now - this._assignedAt < ASSIGNED_TTL_MS) return this._assigned;
      const rows = (await pool.query('SELECT username FROM assigned_users')).rows;
      this._assigned = new Set(rows.map(r => r.username));
      this._assignedAt = now;
      return this._assigned;
    },

    async setGithubAssignments(usernames) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM assigned_users WHERE source = 'github'`);
        const nowIso = new Date().toISOString();
        for (const u of usernames) {
          await client.query(
            `INSERT INTO assigned_users (username, source, updated_at) VALUES ($1, 'github', $2)
             ON CONFLICT (username) DO UPDATE SET source = 'github', updated_at = $2`,
            [u, nowIso]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      this._assigned = null;
      this._assignedAt = 0;
    },

    async getIssueStates() {
      const rows = (await pool.query('SELECT repo, number, state FROM issue_states')).rows;
      return new Map(rows.map(r => [issueStateKey(r.repo, r.number), r.state]));
    },

    async setIssueStates(entries) {
      if (!entries.length) return;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const nowIso = new Date().toISOString();
        for (const e of entries) {
          await client.query(
            `INSERT INTO issue_states (repo, number, state, updated_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (repo, number) DO UPDATE SET state = $3, updated_at = $4`,
            [e.repo, e.number, e.state, nowIso]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async getGroups() {
      const res = await pool.query(`
        SELECT id, group_name, repo, repo_short, issues_json, count, booked_by, booked_at
        FROM groups
        ORDER BY repo_short ASC, id ASC
      `);
      return res.rows.map(r => ({
        id: r.id,
        group_name: r.group_name,
        repo: r.repo,
        repo_short: r.repo_short,
        issues: JSON.parse(r.issues_json),
        count: r.count,
        booked_by: r.booked_by,
        booked_at: r.booked_at,
        is_available: r.booked_by === null
      }));
    },

    async getUserStatus(username, deviceId) {
      const assigned = await this.getAssignedSet();
      if (deviceId) {
        const dev = await pool.query(
          `SELECT r.*, g.group_name, g.repo, g.issues_json
           FROM reservations r JOIN groups g ON r.group_id = g.id
           WHERE r.device_id = $1`,
          [deviceId]
        );
        if (dev.rows.length > 0) {
          const r = dev.rows[0];
          return { has_booked: true, reason: 'device_limit', reservation: {
            group_id: r.group_id, group_name: r.group_name, username: r.username,
            repo: r.repo, issues: JSON.parse(r.issues_json), created_at: r.created_at,
            is_assigned: assigned.has(r.username.toLowerCase())
          }};
        }
      }

      if (username) {
        const usr = await pool.query(
          `SELECT r.*, g.group_name, g.repo, g.issues_json
           FROM reservations r JOIN groups g ON r.group_id = g.id
           WHERE LOWER(r.username) = LOWER($1)`,
          [username]
        );
        if (usr.rows.length > 0) {
          const r = usr.rows[0];
          return { has_booked: true, reason: 'username_limit', reservation: {
            group_id: r.group_id, group_name: r.group_name, username: r.username,
            repo: r.repo, issues: JSON.parse(r.issues_json), created_at: r.created_at,
            is_assigned: assigned.has(r.username.toLowerCase())
          }};
        }
      }

      return { has_booked: false, reservation: null };
    },

    async book(groupId, username, deviceId, nowIso) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check device
        const devCheck = await client.query('SELECT * FROM reservations WHERE device_id = $1', [deviceId]);
        if (devCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return { error: `This device has already reserved group "${devCheck.rows[0].group_id}". 1 booking per device allowed.` };
        }

        // Check user
        const userCheck = await client.query('SELECT * FROM reservations WHERE LOWER(username) = LOWER($1)', [username]);
        if (userCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return { error: `Contributor "${username}" has already reserved group "${userCheck.rows[0].group_id}". 1 booking allowed.` };
        }

        // Check group
        const grpCheck = await client.query('SELECT * FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
        if (grpCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        if (grpCheck.rows[0].booked_by !== null) {
          await client.query('ROLLBACK');
          return { error: `Group already claimed by @${grpCheck.rows[0].booked_by}. Choose another group.` };
        }

        await client.query(
          'INSERT INTO reservations (group_id, username, device_id, created_at) VALUES ($1, $2, $3, $4)',
          [groupId, username, deviceId, nowIso]
        );

        await client.query(
          'UPDATE groups SET booked_by = $1, booked_at = $2, device_id = $3 WHERE id = $4',
          [username, nowIso, deviceId, groupId]
        );

        await client.query('COMMIT');
        return {
          group_name: grpCheck.rows[0].group_name,
          repo: grpCheck.rows[0].repo,
          issues: JSON.parse(grpCheck.rows[0].issues_json)
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async getAdminReservations() {
      const assigned = await this.getAssignedSet();
      const rows = await pool.query(`
        SELECT r.id as reservation_id, r.group_id, g.group_name, g.repo, g.issues_json, r.username, r.device_id, r.created_at
        FROM reservations r JOIN groups g ON r.group_id = g.id
        ORDER BY r.created_at DESC
      `);
      const totalGroups = (await pool.query('SELECT COUNT(*) as count FROM groups')).rows[0].count;
      const formatted = rows.rows.map(r => ({
        reservation_id: r.reservation_id,
        group_id: r.group_id,
        group_name: r.group_name,
        repo: r.repo,
        issues: JSON.parse(r.issues_json),
        username: r.username,
        device_id: r.device_id,
        created_at: r.created_at,
        is_assigned: assigned.has(r.username.toLowerCase())
      }));
      return {
        total_groups: parseInt(totalGroups, 10),
        total_reserved: formatted.length,
        total_assigned: formatted.filter(r => r.is_assigned).length,
        total_unassigned: formatted.filter(r => !r.is_assigned).length,
        available_count: parseInt(totalGroups, 10) - formatted.length,
        reservations: formatted
      };
    },

    async release(groupId) {
      const existing = (await pool.query('SELECT * FROM groups WHERE id = $1', [groupId])).rows[0];
      if (!existing || !existing.booked_by) return null;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM reservations WHERE group_id = $1', [groupId]);
        await client.query('UPDATE groups SET booked_by = NULL, booked_at = NULL, device_id = NULL WHERE id = $1', [groupId]);
        await client.query('COMMIT');
        return existing;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  };

} else {
  // SQLite Fallback
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'scheduler.db');
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      repo TEXT NOT NULL,
      repo_short TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      count INTEGER NOT NULL,
      booked_by TEXT DEFAULT NULL,
      booked_at TEXT DEFAULT NULL,
      device_id TEXT DEFAULT NULL
    );

            CREATE TABLE IF NOT EXISTS reservations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL UNIQUE,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          device_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          FOREIGN KEY(group_id) REFERENCES groups(id)
        );

        CREATE TABLE IF NOT EXISTS assigned_users (
          username TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'github',
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS issue_states (
          repo TEXT NOT NULL,
          number INTEGER NOT NULL,
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (repo, number)
        );
      `);

  const insertGroupStmt = db.prepare(`
    INSERT OR IGNORE INTO groups (id, group_name, repo, repo_short, issues_json, count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const item of seedData) {
    insertGroupStmt.run(item.id, item.group_name, item.repo, item.repo_short, JSON.stringify(item.issues), item.count);
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM assigned_users').get().c === 0) {
    const seedAssigned = db.prepare(
      `INSERT INTO assigned_users (username, source, updated_at) VALUES (?, 'seed', ?)
       ON CONFLICT (username) DO NOTHING`
    );
    const seededAt = new Date().toISOString();
    for (const u of readAssignedSeed()) seedAssigned.run(u, seededAt);
    console.log(`Seeded ${readAssignedSeed().length} assigned usernames from assigned_users.json`);
  }

  dbAdapter = {
    type: 'sqlite',
    async init() {
      console.log(`Connected to SQLite at ${dbPath}`);
    },

    _assigned: null,
    _assignedAt: 0,

    async getAssignedSet() {
      const now = Date.now();
      if (this._assigned && now - this._assignedAt < ASSIGNED_TTL_MS) return this._assigned;
      const rows = db.prepare('SELECT username FROM assigned_users').all();
      this._assigned = new Set(rows.map(r => r.username));
      this._assignedAt = now;
      return this._assigned;
    },

    async setGithubAssignments(usernames) {
      const nowIso = new Date().toISOString();
      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare("DELETE FROM assigned_users WHERE source = 'github'").run();
        const ins = db.prepare(
          `INSERT INTO assigned_users (username, source, updated_at) VALUES (?, 'github', ?)
           ON CONFLICT (username) DO UPDATE SET source = 'github', updated_at = excluded.updated_at`
        );
        for (const u of usernames) ins.run(u, nowIso);
        db.exec('COMMIT;');
      } catch (e) {
        db.exec('ROLLBACK;');
        throw e;
      }
      this._assigned = null;
      this._assignedAt = 0;
    },
    async getIssueStates() {
      const rows = db.prepare('SELECT repo, number, state FROM issue_states').all();
      return new Map(rows.map(r => [issueStateKey(r.repo, r.number), r.state]));
    },
    async setIssueStates(entries) {
      if (!entries.length) return;
      const nowIso = new Date().toISOString();
      const ins = db.prepare(
        `INSERT INTO issue_states (repo, number, state, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo, number) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
      );
      db.exec('BEGIN TRANSACTION;');
      try {
        for (const e of entries) ins.run(e.repo, e.number, e.state, nowIso);
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    },
    async getGroups() {
      const rows = db.prepare(`
        SELECT id, group_name, repo, repo_short, issues_json, count, booked_by, booked_at
        FROM groups ORDER BY repo_short ASC, id ASC
      `).all();
      return rows.map(r => ({
        id: r.id, group_name: r.group_name, repo: r.repo, repo_short: r.repo_short,
        issues: JSON.parse(r.issues_json), count: r.count, booked_by: r.booked_by,
        booked_at: r.booked_at, is_available: r.booked_by === null
      }));
    },
    async getUserStatus(username, deviceId) {
      const assigned = await this.getAssignedSet();
      if (deviceId) {
        const dev = db.prepare(`
          SELECT r.*, g.group_name, g.repo, g.issues_json
          FROM reservations r JOIN groups g ON r.group_id = g.id WHERE r.device_id = ?
        `).get(deviceId);
        if (dev) {
          return { has_booked: true, reason: 'device_limit', reservation: {
            group_id: dev.group_id, group_name: dev.group_name, username: dev.username,
            repo: dev.repo, issues: JSON.parse(dev.issues_json), created_at: dev.created_at,
            is_assigned: assigned.has(dev.username.toLowerCase())
          }};
        }
      }
      if (username) {
        const usr = db.prepare(`
          SELECT r.*, g.group_name, g.repo, g.issues_json
          FROM reservations r JOIN groups g ON r.group_id = g.id WHERE r.username = ? COLLATE NOCASE
        `).get(username);
        if (usr) {
          return { has_booked: true, reason: 'username_limit', reservation: {
            group_id: usr.group_id, group_name: usr.group_name, username: usr.username,
            repo: usr.repo, issues: JSON.parse(usr.issues_json), created_at: usr.created_at,
            is_assigned: assigned.has(usr.username.toLowerCase())
          }};
        }
      }
      return { has_booked: false, reservation: null };
    },
    async book(groupId, username, deviceId, nowIso) {
      const existingDevice = db.prepare('SELECT * FROM reservations WHERE device_id = ?').get(deviceId);
      if (existingDevice) return { error: `This device has already reserved "${existingDevice.group_id}". 1 booking allowed.` };

      const existingUser = db.prepare('SELECT * FROM reservations WHERE username = ? COLLATE NOCASE').get(username);
      if (existingUser) return { error: `Contributor "${username}" has already reserved "${existingUser.group_id}". 1 booking allowed.` };

      const targetGroup = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
      if (!targetGroup) return { notFound: true };
      if (targetGroup.booked_by !== null) return { error: `Group already claimed by @${targetGroup.booked_by}. Choose another group.` };

      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare('INSERT INTO reservations (group_id, username, device_id, created_at) VALUES (?, ?, ?, ?)').run(groupId, username, deviceId, nowIso);
        db.prepare('UPDATE groups SET booked_by = ?, booked_at = ?, device_id = ? WHERE id = ?').run(username, nowIso, deviceId, groupId);
        db.exec('COMMIT;');
      } catch (e) {
        db.exec('ROLLBACK;');
        throw e;
      }
      return {
        group_name: targetGroup.group_name, repo: targetGroup.repo, issues: JSON.parse(targetGroup.issues_json)
      };
    },
    async getAdminReservations() {
      const assigned = await this.getAssignedSet();
      const rows = db.prepare(`
        SELECT r.id as reservation_id, r.group_id, g.group_name, g.repo, g.issues_json, r.username, r.device_id, r.created_at
        FROM reservations r JOIN groups g ON r.group_id = g.id ORDER BY r.created_at DESC
      `).all();
      const totalGroups = db.prepare('SELECT COUNT(*) as count FROM groups').get().count;
      const formatted = rows.map(r => ({
        reservation_id: r.reservation_id, group_id: r.group_id, group_name: r.group_name,
        repo: r.repo, issues: JSON.parse(r.issues_json), username: r.username,
        device_id: r.device_id, created_at: r.created_at,
        is_assigned: assigned.has(r.username.toLowerCase())
      }));
      return {
        total_groups: totalGroups,
        total_reserved: formatted.length,
        total_assigned: formatted.filter(r => r.is_assigned).length,
        total_unassigned: formatted.filter(r => !r.is_assigned).length,
        available_count: totalGroups - formatted.length,
        reservations: formatted
      };
    },
    async release(groupId) {
      const existing = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
      if (!existing || !existing.booked_by) return null;
      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare('DELETE FROM reservations WHERE group_id = ?').run(groupId);
        db.prepare('UPDATE groups SET booked_by = NULL, booked_at = NULL, device_id = NULL WHERE id = ?').run(groupId);
        db.exec('COMMIT;');
        return existing;
      } catch (e) {
        db.exec('ROLLBACK;');
        throw e;
      }
    }
  };
}

// App middlewares & routes
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// SSE
const sseClients = new Set();
function broadcastEvent(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 20000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

// GET /api/groups
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await decorateMany(await dbAdapter.getGroups());
    res.json({ success: true, groups });
  } catch (err) {
    console.error('getGroups error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/user-status
app.get('/api/user-status', async (req, res) => {
  const username = (req.query.username || '').trim();
  const device_id = (req.query.device_id || '').trim();
  if (!device_id) return res.status(400).json({ success: false, error: 'device_id is required' });

  try {
    const status = await dbAdapter.getUserStatus(username, device_id);
    res.json(status);
  } catch (err) {
    console.error('userStatus error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/book
app.post('/api/book', async (req, res) => {
  const cleanUser = (req.body.username || '').trim();
  const cleanDevice = (req.body.device_id || '').trim();
  const cleanGroup = (req.body.group_id || '').trim();

  if (!cleanUser || cleanUser.length < 2 || cleanUser.length > 40 || !/^[a-zA-Z0-9_\-]+$/.test(cleanUser)) {
    return res.status(400).json({ success: false, error: 'Valid username (letters, numbers, _, -) required.' });
  }
  if (!cleanDevice || cleanDevice.length < 10) {
    return res.status(400).json({ success: false, error: 'Valid device identifier required.' });
  }
  if (!cleanGroup) {
    return res.status(400).json({ success: false, error: 'Group ID is required.' });
  }

  const nowIso = new Date().toISOString();

  try {
    const result = await dbAdapter.book(cleanGroup, cleanUser, cleanDevice, nowIso);
    if (result.notFound) {
      return res.status(404).json({ success: false, error: 'Group not found.' });
    }
    if (result.error) {
      return res.status(409).json({ success: false, error: result.error });
    }

    // Explicit audit log to stdout for permanent log tracing
    console.log(`[BOOKING] @${cleanUser} reserved "${cleanGroup}" at ${nowIso} (device: ${cleanDevice})`);

    broadcastEvent('booked', {
      group_id: cleanGroup,
      booked_by: cleanUser,
      booked_at: nowIso
    });

    res.json({
      success: true,
      message: `Group ${result.group_name} reserved successfully!`,
      reservation: {
        group_id: cleanGroup,
        group_name: result.group_name,
        username: cleanUser,
        repo: result.repo,
        issues: result.issues,
        created_at: nowIso
      }
    });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/reservations
app.get('/api/admin/reservations', async (req, res) => {
  try {
    const data = await dbAdapter.getAdminReservations();
    const reservations = await decorateMany(data.reservations);
    res.json({
      success: true,
      ...data,
      reservations,
      total_assigned: reservations.filter(r => r.is_assigned).length,
      total_unassigned: reservations.filter(r => !r.is_assigned).length,
      total_completed: reservations.filter(r => r.completion === 'completed').length,
      // A group whose issues are all closed is finished work, not pending work.
      total_pending: reservations.filter(r => !r.is_assigned && r.completion !== 'completed').length
    });
  } catch (err) {
    console.error('adminReservations error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/release
app.post('/api/admin/release', async (req, res) => {
  const { group_id } = req.body;
  if (!group_id) return res.status(400).json({ success: false, error: 'group_id required' });

  try {
    const released = await dbAdapter.release(group_id);
    if (!released) return res.status(404).json({ success: false, error: 'Group not currently booked' });

    console.log(`[RELEASE] Reservation for "${group_id}" released.`);
    broadcastEvent('booked', { group_id, booked_by: null, booked_at: null });
    res.json({ success: true, message: `Reservation for ${released.group_name} released.` });
  } catch (err) {
    console.error('release error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- GitHub assignment sync -------------------------------------------------
// A booking counts as assigned when the booked contributor is themselves among
// the assignees of at least one of their issues. Issue ownership by some
// other account does not count. Results are stored in assigned_users, so they
// survive redeploys and restarts.
//
// Issue open/closed state is stored in issue_states. Closed issues are marked,
// never deleted: closing is the outcome we want, and a group's record must not
// vanish once the work is finished.
const GH_API_BASE = process.env.GITHUB_API_BASE || 'https://api.github.com';
const SYNC_INTERVAL_MS = Math.max(60 * 1000, parseInt(process.env.SYNC_INTERVAL_MS, 10) || 30 * 60 * 1000);

function issueStateKey(repo, number) {
  return `${String(repo).toLowerCase()}#${number}`;
}

// Attach GitHub state to a group or reservation so the UI can mark closed
// issues and completed groups.
function decorateGroup(group, stateMap) {
  const issues = (group.issues || []).map(i => ({
    ...i,
    state: stateMap.get(issueStateKey(group.repo, i.number)) || null
  }));
  const total = issues.length;
  const closed = issues.filter(i => i.state === 'closed').length;
  let completion = null;
  if (total > 0) {
    if (closed === total) completion = 'completed';
    else if (closed > 0) completion = 'partial';
    else if (issues.every(i => i.state === 'open')) completion = 'open';
  }
  return { ...group, issues, issues_total: total, issues_closed: closed, completion };
}

async function decorateMany(groups) {
  const stateMap = await dbAdapter.getIssueStates();
  return groups.map(g => decorateGroup(g, stateMap));
}

async function ghGet(p) {
  const res = await fetch(`${GH_API_BASE}${p}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'wagmi-issues-scheduler'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

async function syncAssignedFromGitHub() {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not configured on the server');
  }
  const groups = await dbAdapter.getGroups();
  const booked = groups.filter(g => g.booked_by && Array.isArray(g.issues) && g.issues.length);

  const found = [];
  const errors = [];
  const states = new Map();
  let fetched = 0;
  let issuesClosed = 0;
  let groupsAssigned = 0;
  let groupsAssignedToOthers = 0;
  let groupsCompleted = 0;
  let groupsPartial = 0;

  await mapLimit(booked, 5, async (g) => {
    const me = String(g.booked_by).toLowerCase();
    let assignedToMe = false;
    let assignedToAnyone = false;
    let closedHere = 0;
    let seenHere = 0;

    for (const issue of g.issues) {
      try {
        const data = await ghGet(`/repos/${g.repo}/issues/${issue.number}`);
        fetched += 1;
        seenHere += 1;
        // Closed issues keep their assignees, so they still count as evidence
        // of assignment. They are recorded as closed rather than removed.
        const state = data.state === 'closed' ? 'closed' : 'open';
        if (state === 'closed') { closedHere += 1; issuesClosed += 1; }
        states.set(issueStateKey(g.repo, issue.number), {
          repo: String(g.repo).toLowerCase(), number: issue.number, state
        });
        const owners = (data.assignees || []).map(a => String(a.login).toLowerCase());
        if (owners.length) assignedToAnyone = true;
        if (owners.includes(me)) assignedToMe = true;
      } catch (err) {
        errors.push(`${g.repo}#${issue.number}: ${err.message}`);
      }
    }

    if (seenHere > 0 && closedHere === g.issues.length) groupsCompleted += 1;
    else if (closedHere > 0) groupsPartial += 1;

    if (assignedToMe) {
      groupsAssigned += 1;
      found.push(me);
    } else if (assignedToAnyone) {
      groupsAssignedToOthers += 1;
    }
  });

  // A revoked token or a rate limit must never erase real assignment data, so
  // a sync only writes when it could actually read GitHub.
  if (fetched === 0) {
    throw new Error(`Could not read any issue from GitHub (${errors[0] || 'no issues fetched'}); kept previous state.`);
  }
  if (errors.length / fetched > 0.1) {
    throw new Error(`GitHub lookups failed for ${errors.length}/${fetched} issues; kept previous state. First: ${errors[0]}`);
  }

  await dbAdapter.setIssueStates([...states.values()]);
  const usernames = [...new Set(found)];
  await dbAdapter.setGithubAssignments(usernames);
  return {
    groups_checked: booked.length,
    groups_assigned: groupsAssigned,
    groups_assigned_to_others: groupsAssignedToOthers,
    groups_completed: groupsCompleted,
    groups_partial: groupsPartial,
    assigned_users: usernames.length,
    issues_checked: fetched,
    issues_closed: issuesClosed,
    users: usernames.sort(),
    errors
  };
}

// One reconcile at a time; a burst of webhooks collapses into one queued run.
let syncInFlight = null;
let syncQueued = false;

async function runSync(reason) {
  if (syncInFlight) {
    syncQueued = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    try {
      const result = await syncAssignedFromGitHub();
      console.log(`[SYNC:${reason}] ${result.assigned_users} contributor(s) assigned across ${result.groups_assigned}/${result.groups_checked} booked group(s); ${result.issues_closed}/${result.issues_checked} issue(s) closed; ${result.groups_completed} completed, ${result.groups_partial} partial; ${result.errors.length} lookup error(s)`);
      return result;
    } catch (err) {
      console.error(`[SYNC:${reason}] skipped: ${err.message}`);
      throw err;
    } finally {
      syncInFlight = null;
      if (syncQueued) {
        syncQueued = false;
        setTimeout(() => { runSync('queued').catch(() => {}); }, 5000).unref?.();
      }
    }
  })();
  return syncInFlight;
}

// POST /api/admin/sync-assigned (manual trigger)
app.post('/api/admin/sync-assigned', async (req, res) => {
  try {
    const result = await runSync('manual');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('syncAssigned error:', err.message);
    res.status(503).json({ success: false, error: err.message });
  }
});

// POST /api/admin/gh-webhook (GitHub `issues` / `issue_comment` events)
// The shared secret is mandatory: an unauthenticated caller could otherwise
// make the deployment fan out hundreds of API calls per request.
app.post('/api/admin/gh-webhook', (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ success: false, error: 'GITHUB_WEBHOOK_SECRET is not configured on the server' });
  }

  const provided = Buffer.from(String(req.headers['x-hub-signature-256'] || ''));
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex'));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
  }

  const event = String(req.headers['x-github-event'] || 'unknown');
  if (event === 'ping') return res.json({ success: true, pong: true });
  if (!process.env.GITHUB_TOKEN) {
    return res.status(503).json({ success: false, error: 'GITHUB_TOKEN is not configured on the server' });
  }

  // Acknowledge immediately: GitHub gives us 10s and a reconcile is hundreds
  // of API calls.
  res.status(202).json({ success: true, queued: true, event });
  runSync(`webhook:${event}`).catch(() => {});
});

// Start server
(async () => {
  await dbAdapter.init();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Issue Scheduler Server running on http://localhost:${PORT} [${dbAdapter.type.toUpperCase()}]`);
  });

  if (process.env.GITHUB_TOKEN) {
    runSync('startup').catch(() => {});
  } else {
    console.log('[SYNC] GITHUB_TOKEN not set: automatic sync disabled, /api/admin/sync-assigned returns 503');
  }
  const reconcile = setInterval(() => { runSync('interval').catch(() => {}); }, SYNC_INTERVAL_MS);
  reconcile.unref();
  console.log(`[SYNC] Reconciling assigned status and issue state from GitHub every ${Math.round(SYNC_INTERVAL_MS / 60000)} min`);
})();
