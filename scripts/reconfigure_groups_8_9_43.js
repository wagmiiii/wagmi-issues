const { Pool } = require('pg');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const NEON_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_ko9rmLel3JsF@ep-rapid-pond-be1o1sdg-pooler.c-9.us-east-2.aws.neon.tech/neondb?sslmode=require';
const groupsJsonPath = path.join(__dirname, '..', 'groups.json');
const sqliteDbPath = path.join(__dirname, '..', 'scheduler.db');

const group8_issues = [
  { number: 671, url: 'https://github.com/accensa/x402-facilitator-stellar/issues/671' },
  { number: 672, url: 'https://github.com/accensa/x402-facilitator-stellar/issues/672' }
];

const group9_issues = [
  { number: 673, url: 'https://github.com/accensa/x402-facilitator-stellar/issues/673' },
  { number: 674, url: 'https://github.com/accensa/x402-facilitator-stellar/issues/674' }
];

const group43_issues = [
  { number: 675, url: 'https://github.com/accensa/x402-facilitator-stellar/issues/675' },
  { number: 676, url: 'https://github.com/accensa/x402-facilitator-stellar/issues/676' }
];

const newGroup43 = {
  id: 'x402-facilitator-stellar-group-43',
  group_name: 'x402-facilitator-stellar - Group 43',
  repo: 'accensa/x402-facilitator-stellar',
  repo_short: 'x402-facilitator-stellar',
  issues: group43_issues,
  count: 2
};

async function updatePostgres() {
  console.log('Connecting to Neon PostgreSQL...');
  const pool = new Pool({
    connectionString: NEON_URL,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Delete reservations for Group 8 and Group 9
    const delRes = await client.query(`
      DELETE FROM reservations
      WHERE group_id IN ('x402-facilitator-stellar-group-8', 'x402-facilitator-stellar-group-9')
      RETURNING *
    `);
    console.log(`Deleted ${delRes.rows.length} reservation(s) from Postgres:`, delRes.rows.map(r => `${r.group_id} (@${r.username})`));

    // 2. Update Group 8
    await client.query(`
      UPDATE groups
      SET issues_json = $1, count = 2, booked_by = NULL, booked_at = NULL, device_id = NULL
      WHERE id = 'x402-facilitator-stellar-group-8'
    `, [JSON.stringify(group8_issues)]);
    console.log('Updated x402-facilitator-stellar-group-8 (issues 671, 672; free slot)');

    // 3. Update Group 9
    await client.query(`
      UPDATE groups
      SET issues_json = $1, count = 2, booked_by = NULL, booked_at = NULL, device_id = NULL
      WHERE id = 'x402-facilitator-stellar-group-9'
    `, [JSON.stringify(group9_issues)]);
    console.log('Updated x402-facilitator-stellar-group-9 (issues 673, 674; free slot)');

    // 4. Insert or update Group 43
    await client.query(`
      INSERT INTO groups (id, group_name, repo, repo_short, issues_json, count, booked_by, booked_at, device_id)
      VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL)
      ON CONFLICT (id) DO UPDATE SET
        group_name = EXCLUDED.group_name,
        repo = EXCLUDED.repo,
        repo_short = EXCLUDED.repo_short,
        issues_json = EXCLUDED.issues_json,
        count = EXCLUDED.count,
        booked_by = NULL,
        booked_at = NULL,
        device_id = NULL
    `, [newGroup43.id, newGroup43.group_name, newGroup43.repo, newGroup43.repo_short, JSON.stringify(group43_issues), 2]);
    console.log('Inserted/Updated x402-facilitator-stellar-group-43 (issues 675, 676; free slot)');

    await client.query('COMMIT');
    console.log('Postgres transaction committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating Postgres:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

function updateSQLite() {
  if (!fs.existsSync(sqliteDbPath)) {
    console.log('No local SQLite database found.');
    return;
  }
  console.log('Updating local SQLite database...');
  const db = new DatabaseSync(sqliteDbPath);
  try {
    db.exec('BEGIN TRANSACTION;');
    db.prepare(`DELETE FROM reservations WHERE group_id IN ('x402-facilitator-stellar-group-8', 'x402-facilitator-stellar-group-9')`).run();

    db.prepare(`
      UPDATE groups
      SET issues_json = ?, count = 2, booked_by = NULL, booked_at = NULL, device_id = NULL
      WHERE id = 'x402-facilitator-stellar-group-8'
    `).run(JSON.stringify(group8_issues));

    db.prepare(`
      UPDATE groups
      SET issues_json = ?, count = 2, booked_by = NULL, booked_at = NULL, device_id = NULL
      WHERE id = 'x402-facilitator-stellar-group-9'
    `).run(JSON.stringify(group9_issues));

    db.prepare(`
      INSERT INTO groups (id, group_name, repo, repo_short, issues_json, count, booked_by, booked_at, device_id)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT (id) DO UPDATE SET
        group_name = excluded.group_name,
        repo = excluded.repo,
        repo_short = excluded.repo_short,
        issues_json = excluded.issues_json,
        count = excluded.count,
        booked_by = NULL,
        booked_at = NULL,
        device_id = NULL
    `).run(newGroup43.id, newGroup43.group_name, newGroup43.repo, newGroup43.repo_short, JSON.stringify(group43_issues), 2);

    db.exec('COMMIT;');
    console.log('SQLite database updated successfully.');
  } catch (e) {
    db.exec('ROLLBACK;');
    console.error('Error updating SQLite:', e);
  }
}

function updateGroupsJson() {
  console.log('Updating groups.json...');
  const groups = JSON.parse(fs.readFileSync(groupsJsonPath, 'utf8'));

  let found8 = false;
  let found9 = false;
  let found43 = false;

  for (const g of groups) {
    if (g.id === 'x402-facilitator-stellar-group-8') {
      g.issues = group8_issues;
      g.count = 2;
      found8 = true;
    }
    if (g.id === 'x402-facilitator-stellar-group-9') {
      g.issues = group9_issues;
      g.count = 2;
      found9 = true;
    }
    if (g.id === newGroup43.id) {
      g.issues = group43_issues;
      g.count = 2;
      found43 = true;
    }
  }

  if (!found43) {
    // Append right after the last accensa group
    const lastAccensaIdx = groups.findLastIndex(g => g.repo_short === 'x402-facilitator-stellar');
    if (lastAccensaIdx !== -1) {
      groups.splice(lastAccensaIdx + 1, 0, newGroup43);
    } else {
      groups.push(newGroup43);
    }
  }

  fs.writeFileSync(groupsJsonPath, JSON.stringify(groups, null, 2) + '\n', 'utf8');
  console.log(`groups.json updated successfully (total groups: ${groups.length}).`);
}

async function main() {
  await updatePostgres();
  updateSQLite();
  updateGroupsJson();
  console.log('All updates completed!');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
