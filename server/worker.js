import { all, one, run, job, now, id, activity, setting, queueResearch, transaction, bootstrap, setSetting } from './db.js';
import { discover, researchBusiness, buildDraft, checkBusinessWebsite, scanCampaignWebsites } from './research.js';
import { sendNext, syncInbox } from './mail.js';
// DATA_ONLY=1 deploys Scout as a research tool: discover and scrape, never draft or send.
export const dataOnly = () => process.env.DATA_ONLY === '1';
export async function draftCase(caseId) {
  return transaction(async () => {
    const lead = await one('SELECT b.*,cs.id AS case_id,cs.campaign_id FROM cases cs JOIN businesses b ON b.id=cs.business_id WHERE cs.id=?', caseId);
    if (!lead) throw new Error('Lead not found.');
    const campaign = await one('SELECT * FROM campaigns WHERE id=?', lead.campaign_id);
    const sender = await one('SELECT * FROM senders WHERE id=?', campaign.sender_id);
    if (!sender) throw new Error('Choose a sender in campaign settings.');
    const prior = await one("SELECT id,status FROM messages WHERE case_id=? AND direction='outbound' AND kind='initial' AND status NOT IN ('cancelled','failed','blocked') ORDER BY created_at DESC", caseId);
    if (prior) return prior.id;
    const draft = await buildDraft(lead, campaign, sender);
    const key = id();
    await run('INSERT INTO messages(id,case_id,sender_id,recipient,subject,body,created_at) VALUES(?,?,?,?,?,?,?)', key, caseId, sender.id, lead.email, draft.subject, draft.body, now());
    await activity(caseId, 'draft', 'Personalized email draft created.');
    return key;
  });
}
let busy = false;
export async function tick() {
  if (busy) return;
  busy = true;
  const owner = id();
  const acquired = await transaction(async () => {
    const lease = await one('SELECT * FROM worker_leases WHERE key=?', 'worker');
    if (lease && lease.expires > Date.now()) return false;
    await run('INSERT INTO worker_leases(key,owner,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires', 'worker', owner, Date.now() + 10 * 60000);
    return true;
  }).catch(() => false);
  if (!acquired) {
    busy = false;
    return;
  }
  try {
    await bootstrap();
    if (!dataOnly()) await sendNext();
    const task = await one("SELECT * FROM jobs WHERE status='queued' ORDER BY COALESCE(json_extract(payload,'$.priority'),0) DESC,created_at LIMIT 1");
    if (task) {
      let continuation = false;
      await run("UPDATE jobs SET status='running',updated_at=? WHERE id=?", now(), task.id);
      try {
        const payload = JSON.parse(task.payload);
        let result;
        if (task.type === 'discover') {
          const campaign = await one('SELECT * FROM campaigns WHERE id=?', payload.campaignId);
          if (!campaign) throw new Error('Campaign not found.');
          const categories = JSON.parse(campaign.categories);
          const cursor = payload.cursor || 0;
          try { result = await discover({
            ...campaign,
            categories: JSON.stringify([categories[cursor]])
          }, {
            onProgress: async progress => await run('UPDATE jobs SET result=?,updated_at=? WHERE id=?', JSON.stringify(progress), now(), task.id)
          });
          } catch (error) { result = { warnings: [error.message], summary: error.message }; }
          if (cursor + 1 < categories.length) {
            continuation = true;
            await run('UPDATE jobs SET payload=? WHERE id=?', JSON.stringify({
              ...payload,
              cursor: cursor + 1
            }), task.id);
          }
          result.warnings = [...(payload.warnings || []), ...(result.warnings || [])];
          const count = (await one('SELECT count(*) AS n FROM cases WHERE campaign_id=?', campaign.id)).n;
          const coverage = `${Math.min(cursor + 1, categories.length)}/${categories.length} categories checked · ${count} saved listings. ${result.warnings.join(' ')}`;
          await run('UPDATE campaigns SET coverage=? WHERE id=?', coverage, campaign.id);
          result.summary = coverage;
          for (const c of await all('SELECT id,business_id FROM cases WHERE campaign_id=?', campaign.id)) await queueResearch(c.business_id);
        } else if (task.type === 'research') {
          result = await researchBusiness(payload.businessId);
          if (!dataOnly()) for (const c of await all('SELECT cs.id,ca.status,ca.auto_queue FROM cases cs JOIN campaigns ca ON ca.id=cs.campaign_id WHERE cs.business_id=?', payload.businessId)) {
            try {
              const messageId = await draftCase(c.id);
              if (c.status === 'active' && c.auto_queue) await run("UPDATE messages SET status='queued' WHERE id=? AND status='draft'", messageId);
            } catch (e) {
              await activity(c.id, 'attention', e.message);
            }
          }
        } else if (task.type === 'website') {
          if (payload.businessId) result = await checkBusinessWebsite(payload.businessId);
          else if (payload.campaignId) result = await scanCampaignWebsites(payload.campaignId, {
            onProgress: async progress => await run('UPDATE jobs SET result=?,updated_at=? WHERE id=?', JSON.stringify(progress).slice(0, 10000), now(), task.id)
          });
          else throw new Error('Website check needs a business or campaign.');
        } else if (task.type === 'inbox') {
          const sender = await one('SELECT * FROM senders WHERE id=?', payload.senderId);
          if (!sender) throw new Error('Sender not found.');
          result = await syncInbox(sender);
        } else throw new Error('Unknown job type.');
        await run('UPDATE jobs SET status=?,result=?,updated_at=? WHERE id=?', continuation ? 'queued' : result?.warnings?.length ? 'partial' : 'complete', JSON.stringify(result).slice(0, 10000), now(), task.id);
      } catch (e) {
        if (task.type === 'research') await run("UPDATE businesses SET research_status='failed' WHERE id=?", JSON.parse(task.payload).businessId);
        await run("UPDATE jobs SET status='failed',result=?,updated_at=? WHERE id=?", e.message, now(), task.id);
      }
    }
    if (!dataOnly() && Date.now() - Number(await setting('last_inbox_queue', '0')) > 300000) {
      await setSetting('last_inbox_queue', Date.now());
      if ((await setting('auto_sync', '0')) === '1') for (const s of await all("SELECT id FROM senders WHERE verified=1 AND imap_host<>''")) await job('inbox', {
        senderId: s.id
      });
    }
  } catch (e) {
    console.error('Background task failed:', e.code || e.name);
  } finally {
    await run('DELETE FROM worker_leases WHERE key=? AND owner=?', 'worker', owner).catch(() => {});
    busy = false;
  }
}
export function startWorker() {
  const timer = setInterval(tick, 10000);
  timer.unref();
  return timer;
}
