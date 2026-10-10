// One-time, non-destructive import. Run only after stopping the local worker.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, chmodSync } from 'node:fs';
import { parse } from 'dotenv';
const remote = parse(readFileSync('.env.vercel.production'));
if (!remote.DATABASE_URL) throw new Error('Pull production environment variables first.');
process.env.DATABASE_URL = remote.DATABASE_URL;
const { initializeSchema, all, db, transaction, run, one, decrypt } = await import('../server/db.js');
const source = new DatabaseSync('data/scout.sqlite', { readOnly: true });
try {
  if (!source.prepare("SELECT value FROM settings WHERE key='password_hash'").get()) throw new Error('Set a workspace password locally before publishing.');
  for (const sender of source.prepare('SELECT secret FROM senders').all()) decrypt(sender.secret);
  const snapshot = `data/pre-neon-${Date.now()}.sqlite`;
  source.exec(`VACUUM INTO '${snapshot}'`); chmodSync(snapshot, 0o600);
  await initializeSchema();
  const tables = ['settings','senders','campaigns','businesses','cases','messages','activities','suppression','jobs'];
  const counts = {};
  await transaction(async () => {
    for (const table of tables) {
      if ((await one(`SELECT count(*) AS n FROM ${table}`)).n) throw new Error(`Destination ${table} is not empty; refusing to overwrite it.`);
    }
    for (const table of tables) {
      const rows = source.prepare(`SELECT * FROM ${table}`).all();
      counts[table] = rows.length;
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100);
        await run(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`, ...batch.flatMap(row => columns.map(column => row[column])));
      }
      if ((await one(`SELECT count(*) AS n FROM ${table}`)).n !== rows.length) throw new Error(`Count mismatch: ${table}`);
    }
    // A local in-flight SMTP operation must never be sent a second time.
    await run("UPDATE messages SET status='uncertain',error='Migration interrupted delivery. Check the sent mailbox before requeueing.' WHERE status='sending'");
    await run("UPDATE jobs SET status='queued' WHERE status='running'");
  });
  console.log('Migration verified:', JSON.stringify(counts));
  console.log('Campaign states:', JSON.stringify(await all('SELECT status,count(*) AS count FROM campaigns GROUP BY status')));
  console.log('Message states:', JSON.stringify(await all('SELECT status,count(*) AS count FROM messages GROUP BY status')));
} finally { source.close(); await db.close(); }
