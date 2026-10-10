import { parse } from 'dotenv';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const local = parse(readFileSync('.env'));
if (!/^[a-f0-9]{64}$/i.test(local.ENCRYPTION_KEY || '')) throw new Error('Missing local encryption key.');
const secretFile = '.env.deployment-secrets';
const secrets = existsSync(secretFile) ? parse(readFileSync(secretFile)) : { CRON_SECRET: randomBytes(32).toString('hex') };
writeFileSync(secretFile, `CRON_SECRET=${secrets.CRON_SECRET}\n`, { mode: 0o600 });
for (const file of ['.env.vercel.production', secretFile]) chmodSync(file, 0o600);
for (const [name, value] of Object.entries({ ENCRYPTION_KEY: local.ENCRYPTION_KEY, COOKIE_SECURE: '1', CRON_SECRET: secrets.CRON_SECRET })) {
  const child = spawn('vercel', ['env','add',name,'production','--yes','--force','--sensitive','--scope','ajay-raos-projects'], { env: { ...process.env, NO_UPDATE_NOTIFIER: '1' }, stdio: ['pipe','pipe','pipe'] });
  child.stdin.end(value);
  // CLI output is deliberately not echoed: stdin contains a secret.
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const code = await new Promise(resolve => child.on('exit', resolve));
  if (code) throw new Error(`Vercel could not set ${name}; exit ${code}.`);
  console.log(`Configured ${name}.`);
}
