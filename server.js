const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const seedData = JSON.parse(fs.readFileSync(path.join(__dirname, 'groups.json'), 'utf8'));

// Track assigned contributors on GitHub
function getAssignedUsersSet() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'assigned_users.json'), 'utf8'));
    return new Set(list.map(u => u.toLowerCase()));
  } catch (e) {
    return new Set();
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
      console.log('Connected to PostgreSQL (Neon). Seed verification complete.');
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
      const assigned = getAssignedUsersSet();
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
      const assigned = getAssignedUsersSet();
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
  `);

  const insertGroupStmt = db.prepare(`
    INSERT OR IGNORE INTO groups (id, group_name, repo, repo_short, issues_json, count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const item of seedData) {
    insertGroupStmt.run(item.id, item.group_name, item.repo, item.repo_short, JSON.stringify(item.issues), item.count);
  }

  dbAdapter = {
    type: 'sqlite',
    async init() {
      console.log(`Connected to SQLite at ${dbPath}`);
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
      const assigned = getAssignedUsersSet();
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
      const assigned = getAssignedUsersSet();
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
app.use(express.json());
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
    const groups = await dbAdapter.getGroups();
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
    res.json({ success: true, ...data });
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

// Start server
(async () => {
  await dbAdapter.init();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Issue Scheduler Server running on http://localhost:${PORT} [${dbAdapter.type.toUpperCase()}]`);
  });
})();
