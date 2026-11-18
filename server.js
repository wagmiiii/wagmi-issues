const express = require('express');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize SQLite database
const dbPath = process.env.DB_PATH || path.join(__dirname, 'scheduler.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const db = new DatabaseSync(dbPath);

// Enable WAL mode & foreign keys
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Create tables
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

// Seed groups if not present
const seedData = JSON.parse(fs.readFileSync(path.join(__dirname, 'groups.json'), 'utf8'));
const insertGroupStmt = db.prepare(`
  INSERT OR IGNORE INTO groups (id, group_name, repo, repo_short, issues_json, count)
  VALUES (?, ?, ?, ?, ?, ?)
`);

for (const item of seedData) {
  insertGroupStmt.run(
    item.id,
    item.group_name,
    item.repo,
    item.repo_short,
    JSON.stringify(item.issues),
    item.count
  );
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Server-Sent Events (SSE) Client List
const sseClients = new Set();

function broadcastEvent(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// SSE stream endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(': connected\n\n');

  sseClients.add(res);

  // Keep-alive heartbeat every 20 seconds
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// GET /api/groups - List all groups with availability
app.get('/api/groups', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, group_name, repo, repo_short, issues_json, count, booked_by, booked_at
      FROM groups
      ORDER BY repo_short ASC, id ASC
    `).all();

    const result = rows.map(r => ({
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

    res.json({ success: true, groups: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/user-status - Check if username or device has booked
app.get('/api/user-status', (req, res) => {
  const username = (req.query.username || '').trim();
  const device_id = (req.query.device_id || '').trim();

  if (!device_id) {
    return res.status(400).json({ success: false, error: 'device_id is required' });
  }

  try {
    // Check device reservation
    const deviceRes = db.prepare(`
      SELECT r.*, g.group_name, g.repo, g.issues_json 
      FROM reservations r 
      JOIN groups g ON r.group_id = g.id 
      WHERE r.device_id = ?
    `).get(device_id);

    if (deviceRes) {
      return res.json({
        has_booked: true,
        reason: 'device_limit',
        reservation: {
          group_id: deviceRes.group_id,
          group_name: deviceRes.group_name,
          username: deviceRes.username,
          repo: deviceRes.repo,
          issues: JSON.parse(deviceRes.issues_json),
          created_at: deviceRes.created_at
        }
      });
    }

    // Check username reservation if provided
    if (username) {
      const userRes = db.prepare(`
        SELECT r.*, g.group_name, g.repo, g.issues_json 
        FROM reservations r 
        JOIN groups g ON r.group_id = g.id 
        WHERE r.username = ? COLLATE NOCASE
      `).get(username);

      if (userRes) {
        return res.json({
          has_booked: true,
          reason: 'username_limit',
          reservation: {
            group_id: userRes.group_id,
            group_name: userRes.group_name,
            username: userRes.username,
            repo: userRes.repo,
            issues: JSON.parse(userRes.issues_json),
            created_at: userRes.created_at
          }
        });
      }
    }

    res.json({ has_booked: false, reservation: null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/book - Reserve a group atomically
app.post('/api/book', (req, res) => {
  const { group_id, username, device_id } = req.body;

  const cleanUser = (username || '').trim();
  const cleanDevice = (device_id || '').trim();
  const cleanGroup = (group_id || '').trim();

  if (!cleanUser || cleanUser.length < 2 || cleanUser.length > 40) {
    return res.status(400).json({ success: false, error: 'Valid username (2-40 characters) is required.' });
  }

  if (!/^[a-zA-Z0-9_\-]+$/.test(cleanUser)) {
    return res.status(400).json({ success: false, error: 'Username must contain only letters, numbers, hyphens, and underscores.' });
  }

  if (!cleanDevice || cleanDevice.length < 10) {
    return res.status(400).json({ success: false, error: 'Valid device identifier is required.' });
  }

  if (!cleanGroup) {
    return res.status(400).json({ success: false, error: 'Group ID is required.' });
  }

  try {
    // 1. Check if device has already booked
    const existingDevice = db.prepare(`SELECT * FROM reservations WHERE device_id = ?`).get(cleanDevice);
    if (existingDevice) {
      return res.status(409).json({
        success: false,
        error: `This device has already reserved group "${existingDevice.group_id}". One reservation per device is permitted.`
      });
    }

    // 2. Check if username has already booked
    const existingUser = db.prepare(`SELECT * FROM reservations WHERE username = ? COLLATE NOCASE`).get(cleanUser);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: `Contributor "${cleanUser}" has already reserved group "${existingUser.group_id}". Only one reservation per username is permitted.`
      });
    }

    // 3. Check if group exists and is available
    const targetGroup = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(cleanGroup);
    if (!targetGroup) {
      return res.status(404).json({ success: false, error: 'Selected issue group was not found.' });
    }

    if (targetGroup.booked_by !== null) {
      return res.status(409).json({
        success: false,
        error: `This group has already been claimed by @${targetGroup.booked_by}. Please choose another available group.`
      });
    }

    // 4. Atomic booking
    const nowIso = new Date().toISOString();
    db.exec('BEGIN TRANSACTION;');
    try {
      db.prepare(`
        INSERT INTO reservations (group_id, username, device_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(cleanGroup, cleanUser, cleanDevice, nowIso);

      db.prepare(`
        UPDATE groups 
        SET booked_by = ?, booked_at = ?, device_id = ? 
        WHERE id = ?
      `).run(cleanUser, nowIso, cleanDevice, cleanGroup);

      db.exec('COMMIT;');
    } catch (txErr) {
      db.exec('ROLLBACK;');
      throw txErr;
    }

    // 5. Broadcast real-time event to all connected clients
    broadcastEvent('booked', {
      group_id: cleanGroup,
      booked_by: cleanUser,
      booked_at: nowIso
    });

    res.json({
      success: true,
      message: `Group ${targetGroup.group_name} reserved successfully!`,
      reservation: {
        group_id: cleanGroup,
        group_name: targetGroup.group_name,
        username: cleanUser,
        repo: targetGroup.repo,
        issues: JSON.parse(targetGroup.issues_json),
        created_at: nowIso
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/reservations - Admin list of all booked groups
app.get('/api/admin/reservations', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT 
        r.id as reservation_id,
        r.group_id,
        g.group_name,
        g.repo,
        g.issues_json,
        r.username,
        r.device_id,
        r.created_at
      FROM reservations r
      JOIN groups g ON r.group_id = g.id
      ORDER BY r.created_at DESC
    `).all();

    const formatted = rows.map(r => ({
      reservation_id: r.reservation_id,
      group_id: r.group_id,
      group_name: r.group_name,
      repo: r.repo,
      issues: JSON.parse(r.issues_json),
      username: r.username,
      device_id: r.device_id,
      created_at: r.created_at
    }));

    const totalGroups = db.prepare('SELECT COUNT(*) as count FROM groups').get().count;

    res.json({
      success: true,
      total_groups: totalGroups,
      total_reserved: formatted.length,
      available_count: totalGroups - formatted.length,
      reservations: formatted
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/release - Release / cancel a reservation
app.post('/api/admin/release', (req, res) => {
  const { group_id } = req.body;
  if (!group_id) return res.status(400).json({ success: false, error: 'group_id required' });

  try {
    const existing = db.prepare('SELECT * FROM groups WHERE id = ?').get(group_id);
    if (!existing || !existing.booked_by) {
      return res.status(404).json({ success: false, error: 'Group is not currently reserved' });
    }

    db.exec('BEGIN TRANSACTION;');
    try {
      db.prepare('DELETE FROM reservations WHERE group_id = ?').run(group_id);
      db.prepare('UPDATE groups SET booked_by = NULL, booked_at = NULL, device_id = NULL WHERE id = ?').run(group_id);
      db.exec('COMMIT;');
    } catch (txErr) {
      db.exec('ROLLBACK;');
      throw txErr;
    }

    // Broadcast update
    broadcastEvent('booked', {
      group_id: group_id,
      booked_by: null,
      booked_at: null
    });

    res.json({ success: true, message: `Reservation for ${existing.group_name} released.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Issue Scheduler Server running on http://localhost:${PORT}`);
});
