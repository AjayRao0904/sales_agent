import 'dotenv/config';
import { mkdirSync, chmodSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { schema, runtimeSchema, mailboxIdentityMigration } from './schema.js';
export const postgres = !!process.env.DATABASE_URL;
const context = new AsyncLocalStorage();
let sqlite;
let pool;
let tail = Promise.resolve();
if (postgres) {
  pg.types.setTypeParser(20, Number);
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000
  });
  pool.on('error', error => console.error('Database pool error:', error.code));
} else {
  if (process.env.VERCEL) throw new Error('DATABASE_URL is required on Vercel.');
  const {
    DatabaseSync
  } = await import('node:sqlite');
  const dir = process.env.DATA_DIR || 'data';
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700
  });
  chmodSync(dir, 0o700);
  sqlite = new DatabaseSync(`${dir}/scout.sqlite`);
  chmodSync(`${dir}/scout.sqlite`, 0o600);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;' + schema + runtimeSchema);
  const oldIdentity = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get()?.sql;
  if (/message_id TEXT UNIQUE/i.test(oldIdentity || '')) {
    const definition = schema.match(/CREATE TABLE IF NOT EXISTS messages \([\s\S]*?\);/)[0].replace('IF NOT EXISTS messages', 'messages_upgraded');
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(definition + ' INSERT INTO messages_upgraded SELECT * FROM messages; DROP TABLE messages; ALTER TABLE messages_upgraded RENAME TO messages;');
      sqlite.exec(schema); sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
}
// Schema changes are applied explicitly before deployment, not on every cold start.
export async function initializeSchema() {
  if (pool) await pool.query(schema.replace(/expires INTEGER/g, 'expires BIGINT').replace(/\bREAL\b/g, 'DOUBLE PRECISION') + runtimeSchema + mailboxIdentityMigration);
}
export function postgresSql(sql) {
  const ignore = /INSERT OR IGNORE/i.test(sql);
  let n = 0;
  sql = sql.replace(/INSERT OR IGNORE/i, 'INSERT').replace(/json_extract\(payload,'\$\.businessId'\)/g, "(payload::jsonb->>'businessId')").replace(/json_extract\(payload,'\$\.priority'\)/g, "(payload::jsonb->>'priority')::integer");
  sql = sql.replace(/'(?:''|[^'])*'|\?/g, token => token === '?' ? `$${++n}` : token);
  return sql + (ignore ? ' ON CONFLICT DO NOTHING' : '');
}
async function serial(fn) {
  if (context.getStore()) return fn();
  const previous = tail;
  let release;
  tail = new Promise(resolve => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export async function all(sql, ...args) {
  if (pool) return (await (context.getStore()?.client || pool).query(postgresSql(sql), args)).rows;
  return serial(() => sqlite.prepare(sql).all(...args));
}
export async function one(sql, ...args) {
  return (await all(sql, ...args))[0];
}
export async function run(sql, ...args) {
  if (pool) return {
    changes: (await (context.getStore()?.client || pool).query(postgresSql(sql), args)).rowCount
  };
  return serial(() => sqlite.prepare(sql).run(...args));
}
export async function setting(key, fallback = '') {
  return (await one('SELECT value FROM settings WHERE key=?', key))?.value ?? fallback;
}
export const setSetting = (key, value) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
export async function transaction(fn) {
  if (context.getStore()) return fn();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Shared workspace lock serializes quota reservations across Vercel instances.
      await client.query('SELECT pg_advisory_xact_lock(7482051)');
      const value = await context.run({
        client
      }, fn);
      await client.query('COMMIT');
      return value;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return serial(() => context.run({
    sqlite: true
  }, async () => {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const value = await fn();
      sqlite.exec('COMMIT');
      return value;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  }));
}
export const db = {
  exec: sql => pool ? pool.query(sql) : serial(() => sqlite.exec(sql)),
  close: () => pool ? pool.end() : sqlite.close()
};
export function encrypt(value) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) throw new Error('Server encryption key is missing. Run npm run setup.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join('.');
}
export function decrypt(value) {
  const [iv, tag, data] = value.split('.');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY, 'hex'), Buffer.from(iv, 'hex'));
  cipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(data, 'hex')), cipher.final()]).toString('utf8');
}
export function hashPassword(value, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}
export function verifyPassword(value, stored) {
  const [salt] = stored.split(':');
  const a = Buffer.from(hashPassword(value, salt));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function activity(caseId, type, body) {
  await run('INSERT INTO activities VALUES(?,?,?,?,?)', id(), caseId, type, body, now());
}
export async function job(type, payload) {
  return transaction(async () => {
    const pending = await all("SELECT id,payload FROM jobs WHERE type=? AND status IN ('queued','running')", type);
    const existing = pending.find(row => { const value = JSON.parse(row.payload); return ['campaignId','senderId','businessId'].some(key => payload[key] && payload[key] === value[key]) || row.payload === JSON.stringify(payload); });
    if (existing) return existing.id;
    const key = id();
    await run('INSERT INTO jobs(id,type,payload,created_at,updated_at) VALUES(?,?,?,?,?)', key, type, JSON.stringify(payload), now(), now());
    return key;
  });
}
export async function bootstrap() {
  for (const label of ['A', 'B']) {
    const email = process.env[`SMTP_${label}_EMAIL`];
    const pass = process.env[`SMTP_${label}_PASSWORD`];
    if (email && pass && !(await one('SELECT id FROM senders WHERE email=?', email))) await run('INSERT INTO senders(id,email,name,host,port,secret,imap_host,created_at) VALUES(?,?,?,?,?,?,?,?)', id(), email, email.split('@')[0], 'smtp.gmail.com', 465, encrypt(pass.replace(/\s/g, '')), 'imap.gmail.com', now());
  }
  // After a crash, SMTP may have accepted an in-flight message. Never automatically resend it.
  await run("UPDATE messages SET status='uncertain', error='Interrupted during sending. Check the sent mailbox before taking action.' WHERE status='sending' AND sent_at<?", new Date(Date.now() - 15 * 60000).toISOString());
  await run("UPDATE jobs SET status='queued', updated_at=? WHERE status='running' AND updated_at<?", now(), new Date(Date.now() - 15 * 60000).toISOString());
}
export async function queueResearch(businessId, priority = false) {
  return transaction(async () => {
    const existing = await one("SELECT id,payload,status FROM jobs WHERE type='research' AND json_extract(payload,'$.businessId')=? AND status IN ('queued','running') LIMIT 1", businessId);
    if (existing) {
      if (priority && existing.status === 'queued') await run('UPDATE jobs SET payload=? WHERE id=?', JSON.stringify({
        businessId,
        priority: 1
      }), existing.id);
      return existing.id;
    }
    await run("UPDATE businesses SET research_status='queued' WHERE id=?", businessId);
    return await job('research', {
      businessId,
      ...(priority ? {
        priority: 1
      } : {})
    });
  });
}
