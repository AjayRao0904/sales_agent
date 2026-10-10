import pg from 'pg';
import {readFileSync} from 'node:fs';
import {parse} from 'dotenv';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {mailboxIdentityMigration} from '../server/schema.js';
const env=parse(readFileSync('.env.vercel.production'));
const client=new pg.Client({connectionString:env.DATABASE_URL_UNPOOLED||env.POSTGRES_URL_NON_POOLING});
await client.connect();
try{
 const schema=`scout_migration_${randomBytes(6).toString('hex')}`;
 await client.query('BEGIN');
 await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET LOCAL search_path TO ${schema}`);
 await client.query('CREATE TABLE messages(id TEXT PRIMARY KEY,sender_id TEXT,direction TEXT,message_id TEXT UNIQUE)');
 await client.query("INSERT INTO messages VALUES('out','sender-a','outbound','same-rfc-id')");
 await client.query(mailboxIdentityMigration);
 await client.query("INSERT INTO messages VALUES('in','sender-b','inbound','same-rfc-id')");
 assert.equal((await client.query('SELECT count(*) n FROM messages')).rows[0].n,'2');
 await client.query('ROLLBACK');console.log('Migration checked against the old constraint in an isolated schema.');
 await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");
 const before=(await client.query('SELECT count(*) n FROM messages')).rows[0].n;
 await client.query(mailboxIdentityMigration);
 assert.equal((await client.query('SELECT count(*) n FROM messages')).rows[0].n,before);
 await client.query('COMMIT');console.log('Production mailbox-identity migration applied; all message records preserved.');
}catch(e){await client.query('ROLLBACK');throw e;}finally{await client.end();}
