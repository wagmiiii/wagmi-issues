#!/usr/bin/env node
/**
 * reset_db.js
 *
 * Cleanly resets the SQLite database reservations and re-syncs
 * the groups table from groups.json.
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const baseDir = path.join(__dirname, '..');
const dbPath = process.env.DB_PATH || path.join(baseDir, 'scheduler.db');
const groupsPath = path.join(baseDir, 'groups.json');

if (!fs.existsSync(groupsPath)) {
  console.error(`Error: groups.json not found at ${groupsPath}. Run 'npm run sync-issues' first.`);
  process.exit(1);
}

const groups = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));

console.log(`Connecting to database at ${dbPath}...`);
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA foreign_keys = OFF;');
db.exec('BEGIN TRANSACTION;');

try {
  // Wipe reservations and groups
  db.exec('DELETE FROM reservations;');
  db.exec('DELETE FROM groups;');

  const insertStmt = db.prepare(`
    INSERT INTO groups (id, group_name, repo, repo_short, issues_json, count, booked_by, booked_at, device_id)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `);

  for (const g of groups) {
    insertStmt.run(
      g.id,
      g.group_name,
      g.repo,
      g.repo_short,
      JSON.stringify(g.issues),
      g.count
    );
  }

  db.exec('COMMIT;');
  console.log(`✓ Successfully reset database and seeded ${groups.length} available groups.`);
} catch (err) {
  db.exec('ROLLBACK;');
  console.error('Failed to reset database:', err);
  process.exit(1);
}
