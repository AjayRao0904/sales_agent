import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
if (existsSync('.env')) { console.log('Local environment already exists.'); process.exit(0); }
writeFileSync('.env', `HOST=127.0.0.1\nPORT=3001\nENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nCOOKIE_SECURE=0\n`, { mode: 0o600 });
chmodSync('.env', 0o600);
console.log('Created protected local environment.');
