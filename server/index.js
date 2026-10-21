import 'dotenv/config';
import express from 'express';
import { waitUntil } from '@vercel/functions';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { all, one, run, now, id, setting, setSetting, encrypt, hashPassword, verifyPassword, activity, job, bootstrap, transaction, queueResearch } from './db.js';
import { resolveLocation, webUrl } from './network.js';
import { saveBusiness, validEmail } from './research.js';
import { localClock, verifySender, suppress } from './mail.js';
import { startWorker, draftCase, tick, dataOnly } from './worker.js';
if (!process.env.VERCEL) await bootstrap();
export const app = express();
app.disable('x-powered-by');
if (process.env.VERCEL) app.set('trust proxy', 1);
app.use(express.json({
  limit: '100kb'
}));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json({
          error: 'Cross-site requests are blocked.'
        });
      } catch {
        return res.status(403).json({
          error: 'Invalid origin.'
        });
      }
    }
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({
      error: 'Cross-site requests are blocked.'
    });
    if (!req.is('application/json')) return res.status(415).json({
      error: 'JSON request required.'
    });
  }
  next();
});
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const cookieToken = req => (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('scout_session='))?.slice(14) || '';
const authenticated = async req => !!(await one('SELECT token FROM sessions WHERE token=? AND expires>?', tokenHash(cookieToken(req)), Date.now()));
app.get('/api/auth/status', async (req, res) => res.json({
  setup: !(await setting('password_hash')),
  authenticated: await authenticated(req)
}));
app.get('/api/cron', async (req, res) => {
  if (!process.env.CRON_SECRET || req.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return res.sendStatus(401);
  await tick(); res.json({ ok: true });
});
app.post('/api/auth/login', async (req, res) => {
  const password = z.string().min(10).max(200).parse(req.body.password);
  const key = tokenHash(req.ip || 'unknown');
  const allowed = await transaction(async () => {
    let a = await one('SELECT * FROM login_attempts WHERE key=?', key);
    if (!a || a.expires < Date.now()) a = { count: 0, expires: Date.now() + 900000 };
    if (a.count >= 10) return false;
    await run('INSERT INTO login_attempts(key,count,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires', key, a.count + 1, a.expires);
    return true;
  });
  if (!allowed) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const stored = await setting('password_hash');
  if (stored && !verifyPassword(password, stored)) {
    return res.status(401).json({
      error: 'Incorrect workspace password.'
    });
  }
  if (!stored && process.env.VERCEL) return res.status(503).json({ error: 'Workspace setup must be completed before deployment.' });
  if (!stored) await setSetting('password_hash', hashPassword(password));
  await run('DELETE FROM login_attempts WHERE key=?', key);
  const token = randomBytes(32).toString('hex');
  await run('DELETE FROM sessions WHERE expires<?', Date.now());
  await run('INSERT INTO sessions VALUES(?,?)', tokenHash(token), Date.now() + 7 * 86400000);
  res.cookie('scout_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: 7 * 86400000,
    path: '/'
  });
  res.json({
    ok: true
  });
});
app.use('/api', async (req, res, next) => (await authenticated(req)) ? next() : res.status(401).json({
  error: 'Sign in to your workspace.'
}));
const outreachRoute = /^\/api\/(senders|messages)(\/|$)|^\/api\/leads\/[^/]+\/draft$|^\/api\/campaigns\/[^/]+\/status$/;
app.use((req, res, next) => dataOnly() && req.method !== 'GET' && outreachRoute.test(req.path) ? res.status(403).json({
  error: 'Email outreach is turned off in this workspace.'
}) : next());
app.post('/api/auth/logout', async (req, res) => {
  await run('DELETE FROM sessions WHERE token=?', tokenHash(cookieToken(req)));
  res.clearCookie('scout_session');
  res.json({
    ok: true
  });
});
const settingsFields = ['daily_limit', 'timezone', 'start_hour', 'end_hour', 'days', 'spacing_minutes', 'portfolio', 'auto_sync'];
async function publicSettings() {
  return {
    daily_limit: 5,
    timezone: 'Asia/Kolkata',
    start_hour: 9,
    end_hour: 18,
    days: 'Mon,Tue,Wed,Thu,Fri',
    spacing_minutes: 30,
    portfolio: '',
    auto_sync: '0',
    ...Object.fromEntries((await all('SELECT * FROM settings')).filter(x => settingsFields.includes(x.key)).map(x => [x.key, x.value])),
    google_connected: !!(await setting('google_key'))
  };
}
const publicSenders = async () => await all('SELECT id,email,name,host,port,imap_host,verified,health,last_sync FROM senders ORDER BY created_at');
app.get('/api/state', async (req, res) => {
  if (process.env.VERCEL && process.env.DISABLE_WORKER !== '1') waitUntil(tick());
  const day = (await localClock()).day;
  res.json({
    data_only: dataOnly(),
    settings: await publicSettings(),
    senders: await publicSenders(),
    campaigns: (await all('SELECT * FROM campaigns ORDER BY created_at DESC')).map(c => ({
      ...c,
      categories: JSON.parse(c.categories)
    })),
    leads: (await all('SELECT cs.*,b.name,b.category,b.address,b.website,b.email,b.phone,b.maps_url,b.source_url,b.research_status,b.suppressed,b.research,b.website_status,b.website_checked_at,ca.name AS campaign_name FROM cases cs JOIN businesses b ON b.id=cs.business_id JOIN campaigns ca ON ca.id=cs.campaign_id ORDER BY cs.created_at DESC')).map(l => ({
      ...l,
      research: l.research ? JSON.parse(l.research) : null
    })),
    messages: await all('SELECT m.*,b.name AS business_name,s.email AS sender_email FROM messages m JOIN cases c ON c.id=m.case_id JOIN businesses b ON b.id=c.business_id JOIN senders s ON s.id=m.sender_id ORDER BY m.created_at DESC'),
    jobs: await all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 30'),
    daily: await all("SELECT sender_id,count(*) AS count FROM messages WHERE reserved_day=? AND status IN ('sent','sending','uncertain') GROUP BY sender_id", day)
  });
});
app.put('/api/settings', async (req, res) => {
  const s = z.object({
    daily_limit: z.coerce.number().int().min(5).max(10),
    timezone: z.string().max(80),
    start_hour: z.coerce.number().int().min(0).max(23),
    end_hour: z.coerce.number().int().min(1).max(24),
    days: z.string().regex(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(,(Mon|Tue|Wed|Thu|Fri|Sat|Sun))*$/),
    spacing_minutes: z.coerce.number().int().min(5).max(240),
    portfolio: z.string().max(500),
    auto_sync: z.enum(['0', '1']),
    google_key: z.string().max(500).optional()
  }).parse(req.body);
  try {
    new Intl.DateTimeFormat('en', {
      timeZone: s.timezone
    }).format();
  } catch {
    throw new Error('Choose a valid timezone, for example Asia/Kolkata.');
  }
  if (s.start_hour >= s.end_hour) throw new Error('Sending end time must be after start time.');
  if (s.portfolio) webUrl(s.portfolio);
  await transaction(async () => {
    for (const key of settingsFields) await setSetting(key, s[key]);
    if (s.google_key) await setSetting('google_key', encrypt(s.google_key.trim()));
  });
  res.json({
    ok: true
  });
});
app.post('/api/senders', async (req, res) => {
  const s = z.object({
    email: z.email(),
    name: z.string().min(1).max(100),
    host: z.string().regex(/^[a-zA-Z0-9.-]+$/).max(200),
    port: z.coerce.number().refine(v => [465, 587].includes(v)),
    password: z.string().min(1).max(500),
    imap_host: z.string().regex(/^[a-zA-Z0-9.-]*$/).max(200)
  }).parse(req.body);
  await run('INSERT INTO senders(id,email,name,host,port,secret,imap_host,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,host=excluded.host,port=excluded.port,secret=excluded.secret,imap_host=excluded.imap_host,verified=0,health=\'Not checked\'', id(), s.email.toLowerCase(), s.name, s.host, s.port, encrypt(s.password.replace(/\s/g, '')), s.imap_host, now());
  res.json({
    ok: true
  });
});
app.put('/api/senders/:id', async (req, res) => {
  const name = z.string().min(1).max(100).parse(req.body.name);
  await run('UPDATE senders SET name=? WHERE id=?', name, req.params.id);
  res.json({
    ok: true
  });
});
app.post('/api/senders/:id/verify', async (req, res) => {
  const sender = await one('SELECT * FROM senders WHERE id=?', req.params.id);
  if (!sender) return res.sendStatus(404);
  res.json(await verifySender(sender));
});
app.post('/api/senders/:id/sync', async (req, res) => {
  if (!(await one('SELECT id FROM senders WHERE id=?', req.params.id))) return res.sendStatus(404);
  res.json({
    jobId: await job('inbox', {
      senderId: req.params.id
    })
  });
});
app.post('/api/locations/resolve', async (req, res) => res.json(await resolveLocation(z.string().min(1).max(2000).parse(req.body.location))));
const campaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  location: z.string().max(2000).default(''),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  radius: z.coerce.number().int().min(100).max(10000),
  categories: z.array(z.enum(['restaurant', 'cafe', 'fast_food', 'shop', 'salon'])).min(1),
  sender_id: z.string().nullable(),
  price_min: z.number().nonnegative().nullable(),
  price_max: z.number().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  scope: z.string().max(1200),
  auto_queue: z.boolean()
});
async function campaignInput(body) {
  const c = campaignSchema.parse(body);
  if (c.sender_id && !(await one('SELECT id FROM senders WHERE id=?', c.sender_id))) throw new Error('Choose a valid sender.');
  if (c.price_min != null && c.price_max != null && c.price_min > c.price_max) throw new Error('Minimum price must not exceed maximum.');
  return c;
}
app.post('/api/campaigns', async (req, res) => {
  const c = await campaignInput(req.body);
  const key = id();
  await run('INSERT INTO campaigns(id,name,location,lat,lng,radius,categories,sender_id,price_min,price_max,currency,scope,auto_queue,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', key, c.name, c.location, c.lat, c.lng, c.radius, JSON.stringify(c.categories), c.sender_id, c.price_min, c.price_max, c.currency, c.scope, +c.auto_queue, now());
  res.json({
    id: key
  });
});
app.put('/api/campaigns/:id', async (req, res) => {
  const c = await campaignInput(req.body);
  const existing = await one('SELECT * FROM campaigns WHERE id=?', req.params.id);
  if (!existing) return res.sendStatus(404);
  if (existing.status === 'active') throw new Error('Pause this campaign before editing its offer or sender.');
  await transaction(async () => {
    await run('UPDATE campaigns SET name=?,location=?,lat=?,lng=?,radius=?,categories=?,sender_id=?,price_min=?,price_max=?,currency=?,scope=?,auto_queue=? WHERE id=?', c.name, c.location, c.lat, c.lng, c.radius, JSON.stringify(c.categories), c.sender_id, c.price_min, c.price_max, c.currency, c.scope, +c.auto_queue, req.params.id);
    await run("UPDATE messages SET status='cancelled',error='Campaign settings changed. Generate a fresh draft.' WHERE case_id IN (SELECT id FROM cases WHERE campaign_id=?) AND direction='outbound' AND kind='initial' AND status IN ('draft','queued','blocked','failed')", req.params.id);
  });
  res.json({
    ok: true
  });
});
app.post('/api/campaigns/:id/status', async (req, res) => {
  const status = z.enum(['active', 'paused']).parse(req.body.status);
  const c = await one('SELECT * FROM campaigns WHERE id=?', req.params.id);
  if (!c) return res.sendStatus(404);
  if (status === 'active') {
    if (!c.scope || c.price_min == null || c.price_max == null) throw new Error('Set your service scope and price range first.');
    if (!(await one('SELECT id FROM senders WHERE id=? AND verified=1', c.sender_id))) throw new Error('Verify the sender connection in Settings first.');
  }
  await run('UPDATE campaigns SET status=? WHERE id=?', status, c.id);
  if (status === 'active' && c.auto_queue) await run("UPDATE messages SET status='queued' WHERE case_id IN (SELECT id FROM cases WHERE campaign_id=?) AND status='draft'", c.id);
  res.json({
    ok: true
  });
});
app.post('/api/campaigns/:id/discover', async (req, res) => {
  const c = await one('SELECT * FROM campaigns WHERE id=?', req.params.id);
  if (!c || c.lat == null || c.lng == null) throw new Error('Resolve and save a location first.');
  res.json({
    jobId: await job('discover', {
      campaignId: c.id
    })
  });
});
app.post('/api/campaigns/:id/check-websites', async (req, res) => {
  const c = await one('SELECT id FROM campaigns WHERE id=?', req.params.id);
  if (!c) return res.sendStatus(404);
  res.json({
    jobId: await job('website', {
      campaignId: c.id
    })
  });
});
app.post('/api/leads', async (req, res) => {
  const b = z.object({
    campaign_id: z.string(),
    name: z.string().trim().min(1).max(200),
    category: z.string().min(1).max(80),
    address: z.string().max(500).default(''),
    website: z.string().max(1000).default(''),
    email: z.union([z.email(), z.literal('')]).default(''),
    phone: z.string().max(80).default(''),
    source_url: z.string().max(1000).default('')
  }).parse(req.body);
  if (!(await one('SELECT id FROM campaigns WHERE id=?', b.campaign_id))) throw new Error('Create a campaign first.');
  if (b.website) webUrl(b.website);
  if (b.source_url) webUrl(b.source_url);
  const saved = await saveBusiness(b.campaign_id, b);
  await queueResearch(saved.businessId);
  res.json(saved);
});
// Leading =, +, - or @ would run as a formula when the CSV is opened in a spreadsheet.
const csvCell = value => {
  const text = String(value ?? '').replace(/^[=+\-@\t\r]/, "'$&");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export function leadsCsv(leads) {
  const columns = [['Business', l => l.name], ['Category', l => l.category.replaceAll('_', ' ')], ['Address', l => l.address], ['Website', l => l.website], ['Website status', l => l.website_status], ['Email', l => l.email], ['Phone', l => l.phone], ['Maps listing', l => l.maps_url || l.source_url], ['Campaign', l => l.campaign_name], ['Stage', l => l.stage], ['Research status', l => l.research_status], ['Summary', l => l.research?.summary], ['Website mentions', l => l.research?.observations?.map(o => o.detail).join(' | ')], ['Other emails found', l => l.research?.emails?.map(e => e.value).join(' | ')], ['Other phones found', l => l.research?.phones?.map(p => p.value).join(' | ')], ['Sources', l => l.research?.sources?.map(s => s.url).join(' | ')], ['Research gaps', l => l.research?.gaps?.join(' | ')], ['Do not contact', l => l.suppressed ? 'yes' : '']];
  return [columns.map(c => c[0]), ...leads.map(l => columns.map(c => c[1](l)))].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
app.get('/api/leads/export.csv', async (req, res) => {
  const campaign = typeof req.query.campaign === 'string' ? req.query.campaign : '';
  const leads = (await all(`SELECT cs.stage,b.name,b.category,b.address,b.website,b.email,b.phone,b.maps_url,b.source_url,b.research_status,b.suppressed,b.research,b.website_status,ca.name AS campaign_name FROM cases cs JOIN businesses b ON b.id=cs.business_id JOIN campaigns ca ON ca.id=cs.campaign_id${campaign ? ' WHERE cs.campaign_id=?' : ''} ORDER BY cs.created_at DESC`, ...(campaign ? [campaign] : []))).map(l => ({
    ...l,
    research: l.research ? JSON.parse(l.research) : null
  }));
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="scout-prospects-${new Date().toISOString().slice(0, 10)}.csv"`
  }).send('\ufeff' + leadsCsv(leads));
});
app.get('/api/leads/:id/activity', async (req, res) => res.json(await all('SELECT * FROM activities WHERE case_id=? ORDER BY created_at DESC', req.params.id)));
app.put('/api/leads/:id', async (req, res) => {
  const lead = await one('SELECT * FROM cases WHERE id=?', req.params.id);
  if (!lead) return res.sendStatus(404);
  const data = z.object({
    stage: z.enum(['New', 'Qualified', 'Contacted', 'Replied', 'Interested', 'Proposal sent', 'Won', 'Lost']).optional(),
    next_action: z.string().max(1000).optional(),
    due_date: z.string().max(20).optional(),
    email: z.union([z.email(), z.literal('')]).optional(),
    phone: z.string().max(80).optional(),
    website: z.string().max(1000).optional(),
    source_url: z.string().max(1000).optional()
  }).parse(req.body);
  if (data.website) webUrl(data.website);
  if (data.source_url) webUrl(data.source_url);
  await transaction(async () => {
    for (const key of ['stage', 'next_action', 'due_date']) if (data[key] !== undefined) await run(`UPDATE cases SET ${key}=? WHERE id=?`, data[key], lead.id);
    for (const key of ['email', 'phone', 'website', 'source_url']) if (data[key] !== undefined) await run(`UPDATE businesses SET ${key}=? WHERE id=?`, key === 'email' ? data[key].toLowerCase() : data[key], lead.business_id);
    if (data.email !== undefined || data.website !== undefined) await run("UPDATE messages SET status='cancelled',error='Contact changed; generate a new draft.' WHERE case_id IN (SELECT id FROM cases WHERE business_id=?) AND kind='initial' AND status IN ('draft','queued','blocked')", lead.business_id);
    await activity(lead.id, 'updated', data.stage ? `Stage changed to ${data.stage}.` : 'Lead details updated.');
  });
  res.json({
    ok: true
  });
});
app.post('/api/leads/:id/note', async (req, res) => {
  const text = z.string().trim().min(1).max(5000).parse(req.body.body);
  await activity(req.params.id, 'note', text);
  res.json({
    ok: true
  });
});
app.post('/api/leads/:id/research', async (req, res) => {
  const lead = await one('SELECT * FROM cases WHERE id=?', req.params.id);
  if (!lead) return res.sendStatus(404);
  res.json({
    jobId: await queueResearch(lead.business_id, true)
  });
});
app.post('/api/leads/:id/website', async (req, res) => {
  const lead = await one('SELECT * FROM cases WHERE id=?', req.params.id);
  if (!lead) return res.sendStatus(404);
  res.json({
    jobId: await job('website', {
      businessId: lead.business_id
    })
  });
});
app.post('/api/leads/:id/draft', async (req, res) => res.json({
  id: await draftCase(req.params.id)
}));
app.post('/api/leads/:id/suppress', async (req, res) => {
  const lead = await one('SELECT b.*,c.id AS case_id FROM cases c JOIN businesses b ON b.id=c.business_id WHERE c.id=?', req.params.id);
  if (!lead) return res.sendStatus(404);
  await run('UPDATE businesses SET suppressed=1 WHERE id=?', lead.id);
  if (lead.email) await suppress(lead.email, 'Marked do not contact by operator', lead.case_id);
  res.json({
    ok: true
  });
});
app.put('/api/messages/:id', async (req, res) => {
  const m = await one('SELECT * FROM messages WHERE id=?', req.params.id);
  if (!m || m.status !== 'draft') throw new Error('Only drafts can be edited.');
  const data = z.object({
    subject: z.string().trim().min(1).max(250),
    body: z.string().trim().min(1).max(20000)
  }).parse(req.body);
  await run('UPDATE messages SET subject=?,body=? WHERE id=?', data.subject, data.body, m.id);
  res.json({
    ok: true
  });
});
app.post('/api/messages/:id/queue', async (req, res) => {
  const m = await one('SELECT * FROM messages WHERE id=?', req.params.id);
  if (!m || !['draft', 'failed', 'blocked'].includes(m.status)) throw new Error('This message cannot be queued.');
  if (!validEmail(m.recipient)) throw new Error('Invalid recipient email.');
  await run("UPDATE messages SET status='queued',error=NULL WHERE id=?", m.id);
  await activity(m.case_id, 'queue', 'Email added to the sending queue.');
  res.json({
    ok: true
  });
});
app.post('/api/messages/:id/cancel', async (req, res) => {
  await run("UPDATE messages SET status='cancelled' WHERE id=? AND status IN ('draft','queued','blocked','failed')", req.params.id);
  res.json({
    ok: true
  });
});
app.post('/api/messages/:id/reply', async (req, res) => {
  const parent = await one('SELECT * FROM messages WHERE id=?', req.params.id);
  if (!parent || parent.direction !== 'inbound') throw new Error('Choose an incoming message to reply to.');
  const body = z.string().trim().min(1).max(20000).parse(req.body.body);
  const key = id();
  await run('INSERT INTO messages(id,case_id,sender_id,recipient,subject,body,kind,in_reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?)', key, parent.case_id, parent.sender_id, parent.recipient, /^Re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`, body, 'reply', parent.message_id, now());
  res.json({
    id: key
  });
});
app.use('/api', (req, res) => res.status(404).json({
  error: 'API endpoint not found.'
}));
if (existsSync('dist/index.html')) {
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (req, res) => res.sendFile(resolve('dist/index.html')));
}
app.use((err, req, res, next) => {
  if (err instanceof z.ZodError) return res.status(400).json({
    error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
  });
  const safe = !/SQLITE|constraint|FOREIGN KEY/i.test(err.message);
  res.status(400).json({
    error: safe ? err.message : 'This change could not be saved. Check the selected records and try again.'
  });
});
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  const host = process.env.HOST || '127.0.0.1';
  const port = +(process.env.PORT || 3001);
  app.listen(port, host, () => console.log(`Scout is available at http://${host}:${port}`));
  if (process.env.DISABLE_WORKER !== '1') startWorker();
}

export default app;
