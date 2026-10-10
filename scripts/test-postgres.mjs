import pg from 'pg';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const remote = parse(readFileSync('.env.vercel.production'));
const connectionString = remote.DATABASE_URL_UNPOOLED || remote.POSTGRES_URL_NON_POOLING;
if (!connectionString) throw new Error('An unpooled URL is needed for isolated schema tests.');
const pool = new pg.Pool({ connectionString });
const schema = `scout_test_${randomBytes(8).toString('hex')}`;
try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  const child = spawn(process.execPath, ['--test', 'tests/core.test.js'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema}`, TEST_POSTGRES: '1' } });
  process.exitCode = await new Promise(resolve => child.on('exit', resolve));
} finally { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); }
