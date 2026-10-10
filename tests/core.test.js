import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
if (!process.env.TEST_POSTGRES) process.env.DATABASE_URL = '';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'scout-test-'));
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.NODE_ENV = 'test';
process.env.SMTP_A_EMAIL = '';
process.env.SMTP_B_EMAIL = '';
const {
  db,
  run,
  one,
  setting,
  setSetting,
  encrypt,
  decrypt,
  bootstrap,
  now
} = await import('../server/db.js');
if (process.env.TEST_POSTGRES === '1') {
  if (!/^scout_test_[a-f0-9]+$/.test((await one('SELECT current_schema() AS name')).name || '')) throw new Error('Refusing tests outside isolated schema');
  await (await import('../server/db.js')).initializeSchema();
}
const {
  reserveMessage,
  localClock,
  suppress,
  eligibility
} = await import('../server/mail.js');
const {
  extractPage,
  buildDraft,
  saveBusiness,
  discover
} = await import('../server/research.js');
const {
  publicAddress,
  coordinates,
  webUrl
} = await import('../server/network.js');
const {
  app
} = await import('../server/index.js');
const monday = new Date('2026-10-05T05:00:00Z');
beforeEach(async () => {
  await db.exec('DELETE FROM activities; DELETE FROM messages; DELETE FROM cases; DELETE FROM businesses; DELETE FROM campaigns; DELETE FROM senders; DELETE FROM suppression; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM settings; DELETE FROM login_attempts; DELETE FROM worker_leases;');
  await setSetting('timezone', 'Asia/Kolkata');
  await setSetting('daily_limit', '5');
  await run('INSERT INTO senders(id,email,name,host,port,secret,verified,created_at) VALUES(?,?,?,?,?,?,?,?)', 'sender', 'sender@example.com', 'Test', 'smtp.example.com', 465, encrypt('not-a-real-secret'), 1, now());
  await run('INSERT INTO campaigns(id,name,sender_id,price_min,price_max,scope,status,created_at) VALUES(?,?,?,?,?,?,?,?)', 'campaign', 'Test', 'sender', 100, 200, 'a simple business website', 'active', now());
});
async function lead(i = 0, email = `hello${i}@example.org`) {
  return await saveBusiness('campaign', {
    provider_id: `test:${i}`,
    name: `Business ${i}`,
    category: 'cafe',
    address: `Street ${i}`,
    email,
    source_url: 'https://example.org/listing'
  });
}
async function queue(i = 0, email) {
  const l = await lead(i, email);
  await run('INSERT INTO messages(id,case_id,sender_id,recipient,subject,body,status,created_at) VALUES(?,?,?,?,?,?,?,?)', `message${i}`, l.caseId, 'sender', email || `hello${i}@example.org`, 'Hello', 'A test message', 'queued', now());
  return l;
}
test('credentials are encrypted and round trip without plaintext', () => {
  const encrypted = encrypt('private password');
  assert(!encrypted.includes('private'));
  assert.equal(decrypt(encrypted), 'private password');
});
test('daily cap holds across leads and concurrent reservations', async () => {
  for (let i = 0; i < 7; i++) await queue(i);
  await setSetting('spacing_minutes', '0');
  const results = await Promise.all(Array.from({
    length: 7
  }, async (_, i) => await reserveMessage(`message${i}`, monday)));
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal((await one("SELECT count(*) n FROM messages WHERE status='sending'")).n, 5);
});
test('daily cap is shared across separate sender accounts', async () => {
  await setSetting('spacing_minutes', '0');
  for (let i = 0; i < 5; i++) {
    await queue(i);
    assert(await reserveMessage(`message${i}`, monday));
  }
  await run('INSERT INTO senders(id,email,name,host,port,secret,verified,created_at) VALUES(?,?,?,?,?,?,?,?)', 'second', 'second@example.com', 'Second', 'smtp.example.com', 465, encrypt('test-only'), 1, now());
  await queue(6);
  await run('UPDATE messages SET sender_id=? WHERE id=?', 'second', 'message6');
  assert.equal(await reserveMessage('message6', monday), null);
});
test('same-name branches without addresses remain distinct', async () => {
  const first = await saveBusiness('campaign', {
    provider_id: 'branch:1',
    name: 'Local Chain',
    category: 'cafe',
    lat: 12,
    lng: 77
  });
  const second = await saveBusiness('campaign', {
    provider_id: 'branch:2',
    name: 'Local Chain',
    category: 'cafe',
    lat: 12.01,
    lng: 77.01
  });
  assert.notEqual(first.businessId, second.businessId);
  const duplicate = await saveBusiness('campaign', {
    provider_id: 'branch:3',
    name: 'Local Chain',
    category: 'cafe',
    lat: 12.00001,
    lng: 77.00001
  });
  assert.equal(first.businessId, duplicate.businessId);
});
test('duplicate recipient across businesses is blocked', async () => {
  await queue(1, 'same@example.org');
  await queue(2, 'same@example.org');
  assert(await reserveMessage('message1', monday));
  assert.equal(await reserveMessage('message2', monday), null);
  assert.equal((await one('SELECT status FROM messages WHERE id=?', 'message2')).status, 'blocked');
});
test('paused campaign and outside hours never reserve', async () => {
  await queue();
  await run("UPDATE campaigns SET status='paused'");
  assert.equal(await reserveMessage('message0', monday), null);
  await run("UPDATE campaigns SET status='active'");
  assert.equal(await reserveMessage('message0', new Date('2026-10-05T20:00:00Z')), null);
  assert.equal((await one('SELECT status FROM messages')).status, 'queued');
});
test('spacing is enforced between messages', async () => {
  await queue(0);
  await queue(1);
  assert(await reserveMessage('message0', monday));
  assert.equal(await reserveMessage('message1', monday), null);
  assert(await reserveMessage('message1', new Date(monday.getTime() + 31 * 60000)));
});
test('opt-out cancels pending outreach and survives rediscovery', async () => {
  const l = await queue();
  await suppress('hello0@example.org', 'Opt out', l.caseId);
  assert.equal((await one('SELECT status FROM messages')).status, 'cancelled');
  assert.equal((await one('SELECT suppressed FROM businesses')).suppressed, 1);
  assert.equal((await saveBusiness('campaign', {
    provider_id: 'test:0',
    name: 'Business 0',
    category: 'cafe',
    address: 'Street 0'
  })).added, false);
});
test('restart marks in-flight delivery uncertain and does not retry', async () => {
  await queue();
  assert(await reserveMessage('message0', monday));
  await bootstrap();
  assert.equal((await one('SELECT status FROM messages')).status, 'uncertain');
  assert.equal(await reserveMessage('message0', monday), null);
});
test('website extraction keeps public contact sources and removes script content', () => {
  const p = extractPage('<html><head><title>Local Cafe</title></head><body><script>secret@example.net</script><a href="mailto:hello@cafe.org">Email</a><a href="tel:+919999999999">Phone</a><a href="/contact">Contact</a></body></html>', 'https://cafe.org');
  assert.deepEqual(p.emails, ['hello@cafe.org']);
  assert.equal(p.phones[0], '+919999999999');
  assert.equal(p.links[0], 'https://cafe.org/contact');
});
test('URL handling blocks local addresses and parses exact Maps coordinates', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '192.168.0.1']) assert.equal(publicAddress(ip), false, ip);
  assert(publicAddress('8.8.8.8'));
  assert.throws(() => webUrl('file:///etc/passwd'));
  assert.throws(() => webUrl('http://user:pass@example.com'));
  assert.deepEqual(coordinates('https://www.google.com/maps/place/Cafe/@12.9,77.6,15z/data=!3d13.1!4d77.2'), {
    lat: 13.1,
    lng: 77.2
  });
});
test('draft is grounded in recorded facts and refuses missing prices', async () => {
  const b = {
    name: 'Local Cafe',
    category: 'cafe',
    address: 'Market Road',
    research_status: 'complete',
    email: 'hello@cafe.org'
  };
  const c = {
    scope: 'a responsive website',
    price_min: 100,
    price_max: 200,
    currency: 'INR'
  };
  const s = {
    name: 'Ajay',
    email: 'sender@example.com'
  };
  const d = await buildDraft(b, c, s);
  assert(d.body.includes('Market Road'));
  assert(d.body.includes('INR 100–200'));
  assert(!d.body.includes('you have no website'));
  await assert.rejects(async () => await buildDraft(b, {
    ...c,
    price_min: null
  }, s));
});
test('authenticated API persists a campaign and never exposes SMTP secrets', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(base + '/api/state');
    assert.equal(r.status, 401);
    r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        password: 'testing-password-123'
      })
    });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    r = await fetch(base + '/api/state', {
      headers: {
        Cookie: cookie
      }
    });
    const text = await r.text();
    assert(!text.includes('not-a-real-secret'));
    assert(!text.includes('password_hash'));
    assert(!text.includes('"secret"'));
    assert.equal(JSON.parse(text).senders.length, 1);
    r = await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example'
      },
      body: '{}'
    });
    assert.equal(r.status, 403);
    r = await fetch(base + '/api/campaigns', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Second',
        location: '12,77',
        lat: 12,
        lng: 77,
        radius: 1000,
        categories: ['cafe'],
        sender_id: 'sender',
        price_min: 100,
        price_max: 200,
        currency: 'INR',
        scope: 'a website',
        auto_queue: false
      })
    });
    assert.equal(r.status, 200);
    assert(await one('SELECT id FROM campaigns WHERE name=?', 'Second'));
  } finally {
    await new Promise(r => server.close(r));
  }
});
test('discovery saves partial category results and reports provider timeouts', async () => {
  const progress = [];
  let cafeCalls = 0;
  const result = await discover({
    id: 'campaign',
    lat: 12,
    lng: 77,
    radius: 3000,
    categories: '["restaurant","cafe"]'
  }, {
    retryDelay: async () => {},
    onProgress: p => progress.push(p),
    fetcher: async url => {
      const cafe = new URL(url).searchParams.get('data').includes('[amenity=cafe]');
      if (cafe) {
        cafeCalls++;
        assert.equal((await one('SELECT count(*) AS n FROM cases')).n, cafeCalls === 1 ? 1 : 2);
      }
      return {
        ok: true,
        json: async () => ({
          elements: [{
            type: 'node',
            id: cafe ? 92 : 91,
            lat: 12,
            lon: 77,
            tags: {
              name: cafe ? 'Partial Cafe' : 'Saved Restaurant',
              amenity: cafe ? 'cafe' : 'restaurant'
            }
          }],
          ...(cafe ? {
            remark: 'runtime error: Query timed out'
          } : {})
        })
      };
    }
  });
  assert.equal(result.added, 2);
  assert.equal(result.found, 2);
  assert.equal(cafeCalls, 2);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Query timed out/);
  assert.equal((await one('SELECT count(*) AS n FROM cases')).n, 2);
  assert(progress.some(p => p.summary.includes('Retrying')));
});
test('discovery reports a clear failure if every category is unavailable', async () => {
  await assert.rejects(discover({
    id: 'campaign',
    lat: 12,
    lng: 77,
    radius: 3000,
    categories: '["cafe"]'
  }, {
    retryDelay: async () => {},
    fetcher: async () => ({
      ok: false,
      status: 503
    })
  }), /HTTP 503/);
  assert.equal((await one('SELECT count(*) AS n FROM cases')).n, 0);
});
test('bounding-box search excludes businesses outside the selected radius', async () => {
  const result = await discover({
    id: 'campaign',
    lat: 12,
    lng: 77,
    radius: 1000,
    categories: '["cafe"]'
  }, {
    retryDelay: async () => {},
    fetcher: async url => {
      assert(!new URL(url).searchParams.get('data').includes('(around:'));
      return {
        ok: true,
        json: async () => ({
          elements: [{
            type: 'node',
            id: 81,
            lat: 12.005,
            lon: 77.005,
            tags: {
              name: 'Inside',
              amenity: 'cafe'
            }
          }, {
            type: 'node',
            id: 82,
            lat: 12.0085,
            lon: 77.0085,
            tags: {
              name: 'Outside circle',
              amenity: 'cafe'
            }
          }]
        })
      };
    }
  });
  assert.equal(result.added, 1);
  assert.equal((await one('SELECT name FROM businesses')).name, 'Inside');
});
test('automatic contact lookup matches the correct branch and rejects other branches', async () => {
  const {
    matchBusinessPage
  } = await import('../server/contacts.js');
  const b = {
    name: 'Test Cafe',
    lat: 12,
    lng: 77
  };
  const page = lat => `<h1>Test Cafe</h1><script type="application/ld+json">${JSON.stringify({
    '@type': 'Restaurant',
    name: 'Test Cafe',
    geo: {
      latitude: lat,
      longitude: 77
    },
    telephone: '+919999999999',
    email: 'hello@testcafe.org',
    address: {
      streetAddress: '12 Market Road',
      addressLocality: 'Bengaluru'
    }
  })}</script>`;
  assert.equal(matchBusinessPage(b, page(12.001), 'https://testcafe.org').phone, '+919999999999');
  assert.equal(matchBusinessPage(b, page(12.05), 'https://testcafe.org'), null);
  assert.equal(matchBusinessPage(b, page(12.001), 'https://www.justdial.com/cafe'), null);
});
test('contact lookup follows search candidates and saves only a verified match', async () => {
  const {
    findBusinessContacts
  } = await import('../server/contacts.js');
  const html = '<h1>Verified Shop</h1><script type="application/ld+json">' + JSON.stringify({
    '@type': 'Store',
    name: 'Verified Shop',
    geo: {
      latitude: 12,
      longitude: 77
    },
    telephone: '+911234567890',
    email: 'hello@verified-shop.test'
  }) + '</script>';
  const result = await findBusinessContacts({
    name: 'Verified Shop',
    lat: 12,
    lng: 77
  }, 'Bengaluru', {
    search: async () => ({
      text: '<a class="result__a" href="https://verified-shop.test/contact">Shop</a>'
    }),
    fetchPage: async url => ({
      url,
      text: url.endsWith('robots.txt') ? 'User-agent: *\nAllow: /' : html
    })
  });
  assert.equal(result.match.email, 'hello@verified-shop.test');
  assert.equal(result.match.phone, '+911234567890');
});
test('opening a lead prioritizes one existing research job instead of adding duplicates', async () => {
  const {
    queueResearch
  } = await import('../server/db.js');
  const l = await lead(99);
  const queued = await queueResearch(l.businessId);
  assert.equal(await queueResearch(l.businessId, true), queued);
  assert.equal((await one("SELECT count(*) n FROM jobs WHERE type='research'")).n, 1);
  assert.equal(JSON.parse((await one('SELECT payload FROM jobs WHERE id=?', queued)).payload).priority, 1);
});
test('concurrent research requests create only one queued job', async () => {
  const { queueResearch } = await import('../server/db.js');
  const l = await lead(110);
  const ids = await Promise.all(Array.from({ length: 5 }, () => queueResearch(l.businessId, true)));
  assert.equal(new Set(ids).size, 1);
  assert.equal((await one("SELECT count(*) n FROM jobs WHERE type='research'")).n, 1);
});
test('a cold start preserves another request’s recent sending and running work', async () => {
  await queue();
  await run("UPDATE messages SET status='sending',sent_at=?", now());
  await run("INSERT INTO jobs(id,type,payload,status,created_at,updated_at) VALUES(?,?,?,?,?,?)", 'fresh-job', 'research', '{}', 'running', now(), now());
  await bootstrap();
  assert.equal((await one('SELECT status FROM messages')).status, 'sending');
  assert.equal((await one("SELECT status FROM jobs WHERE id='fresh-job'")).status, 'running');
});
test('a live database worker lease prevents another worker consuming jobs', async () => {
  const { tick } = await import('../server/worker.js');
  await run('INSERT INTO worker_leases VALUES(?,?,?)', 'worker', 'another-instance', Date.now() + 600000);
  await run('INSERT INTO jobs(id,type,payload,created_at,updated_at) VALUES(?,?,?,?,?)', 'pending-job', 'unknown', '{}', now(), now());
  await tick();
  assert.equal((await one("SELECT status FROM jobs WHERE id='pending-job'")).status, 'queued');
  assert.equal((await one("SELECT owner FROM worker_leases WHERE key='worker'")).owner, 'another-instance');
});
test('discovery retries on another public provider after a gateway failure', async () => {
  const { searchOpenStreetMap } = await import('../server/discovery.js');
  const hosts = [];
  const result = await searchOpenStreetMap({ lat: 12, lng: 77, radius: 100, categories: '["cafe"]' }, {
    retryDelay: async () => {},
    fetcher: async url => { hosts.push(new URL(url).hostname); return hosts.length === 1 ? { ok: false, status: 504 } : { ok: true, json: async () => ({ elements: [] }) }; }
  });
  assert.equal(hosts.length, 2); assert.notEqual(hosts[0], hosts[1]);
  assert.deepEqual(result.completed, ['cafe']); assert.deepEqual(result.warnings, []);
});
test('outgoing copies do not hide incoming mail with the same RFC Message-ID', async () => {
  const { hasImportedMessage } = await import('../server/mail.js');
  const l = await lead(900);
  await run('INSERT INTO senders(id,email,name,host,port,secret,verified,created_at) VALUES(?,?,?,?,?,?,?,?)', 'receiver', 'receiver@example.com', 'Receiver', 'smtp.example.com', 465, encrypt('test'), 1, now());
  const messageId = '<shared-rfc-id@example.com>';
  await run('INSERT INTO messages(id,case_id,sender_id,recipient,subject,body,message_id,created_at) VALUES(?,?,?,?,?,?,?,?)', 'copy-out', l.caseId, 'sender', 'receiver@example.com', 'Test', 'Body', messageId, now());
  assert.equal(await hasImportedMessage('receiver', messageId), false);
  await run('INSERT INTO messages(id,case_id,sender_id,recipient,subject,body,direction,message_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'copy-in', l.caseId, 'receiver', 'sender@example.com', 'Test', 'Body', 'inbound', messageId, now());
  assert.equal(await hasImportedMessage('receiver', messageId), true);
  assert.equal(await hasImportedMessage('sender', messageId), false);
  await assert.rejects(run('INSERT INTO messages(id,case_id,sender_id,recipient,subject,body,direction,message_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'duplicate-in', l.caseId, 'receiver', 'sender@example.com', 'Test', 'Body', 'inbound', messageId, now()));
});
after(async () => {
  await db.close();
  rmSync(process.env.DATA_DIR, {
    recursive: true,
    force: true
  });
});
