import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parse } from 'dotenv';
import pg from 'pg';
import { chromium } from '@playwright/test';
const password = readFileSync(0, 'utf8').trim();
const base = 'https://scout-sales-agent.vercel.app';
const pool = new pg.Pool({ connectionString: parse(readFileSync('.env.vercel.production')).DATABASE_URL });
const report = [], tempCampaigns = [], ownedJobs = new Set();
let cookie, browser;
const stamp = Date.now();
async function check(name, fn) { if (process.argv.includes('--discovery-only') && /SMTP|website research|Draft generation|desktop routes|inbox sync/.test(name)) return; try { const detail = await fn(); report.push({ name, passed: true, detail }); console.log(`PASS ${name}${detail ? ': ' + detail : ''}`); } catch (e) { report.push({ name, passed: false, error: e.message }); console.log(`FAIL ${name}: ${e.message}`); } }
async function api(path, method = 'GET', body, expected = 200) {
 const r = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
 const text = await r.text(); assert.equal(r.status, expected, `${method} ${path}: HTTP ${r.status}, ${text.slice(0,160)}`); return text ? JSON.parse(text) : null;
}
async function waitJob(id, limit = 210000) {
 const end = Date.now() + limit; let state;
 while (Date.now() < end) {
  state = (await pool.query('SELECT status,result FROM jobs WHERE id=$1',[id])).rows[0];
  if (['complete','partial','failed'].includes(state?.status)) return state;
  await api('/api/state'); await new Promise(r=>setTimeout(r,4000));
 }
 throw new Error(`Job remains ${state?.status} after ${limit/1000}s`);
}
async function prioritize(id) {
 await pool.query("UPDATE jobs SET payload=(payload::jsonb || '{\"priority\":5}'::jsonb)::text WHERE id=$1 AND status='queued'",[id]);
}
try {
 await check('Public authentication guards', async () => {
  const status = await api('/api/auth/status'); assert.equal(status.setup,false); assert.equal(status.authenticated,false);
  await api('/api/state','GET',null,401);
  assert.equal((await fetch(base+'/api/cron')).status,401);
 });
 await check('Actual password login', async () => {
  const r = await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
  assert.equal(r.status,200); cookie=r.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
  assert(r.headers.get('set-cookie').includes('Secure')); assert(r.headers.get('set-cookie').includes('HttpOnly'));
 });
 if (!cookie) throw new Error('Cannot continue authenticated tests.');
 let initial;
 await check('Persistent dashboard and secret redaction',async()=>{
  initial=await api('/api/state'); assert(initial.leads.length>=300); assert.equal(initial.senders.length,2);
  assert(!JSON.stringify(initial).includes('password_hash')); assert(initial.senders.every(s=>!('secret' in s)));
  return `${initial.leads.length} leads, ${initial.senders.length} senders; Google Places ${initial.settings.google_connected?'connected':'not configured'}`;
 });
 for(const sender of initial.senders) await check(`Live SMTP authentication (${sender.email})`,async()=>{assert.equal((await api(`/api/senders/${sender.id}/verify`,'POST',{})).ok,true);return 'Authenticated from Vercel; no message sent';});
 await check('Google Maps coordinate resolution',async()=>{const r=await api('/api/locations/resolve','POST',{location:'https://www.google.com/maps/@12.97,77.59,15z'});assert.equal(r.lat,12.97);assert.equal(r.lng,77.59);});
 let campaign, lead;
 await check('Campaign and lead creation, CRM stage and notes',async()=>{
  campaign=await api('/api/campaigns','POST',{name:`Live QA ${stamp}`,location:'12.97,77.59',lat:12.97,lng:77.59,radius:100,categories:['cafe'],sender_id:initial.senders[0].id,price_min:10000,price_max:20000,currency:'INR',scope:'a test website',auto_queue:false});tempCampaigns.push(campaign.id);
  lead=await api('/api/leads','POST',{campaign_id:campaign.id,name:`Scout QA fixture ${stamp}`,category:'cafe',email:`qa-${stamp}@example.org`,phone:'+12025550123',website:'https://example.org',source_url:'https://example.org'});
  await api(`/api/leads/${lead.caseId}`,'PUT',{stage:'Qualified',next_action:'QA persistence check'});
  await api(`/api/leads/${lead.caseId}/note`,'POST',{body:'Temporary live verification note'});
  const events=await api(`/api/leads/${lead.caseId}/activity`);assert(events.some(e=>e.body==='Temporary live verification note'));
  const saved=(await api('/api/state')).leads.find(l=>l.id===lead.caseId);assert.equal(saved.stage,'Qualified');
 });
 if(lead) {
 await check('Live website research worker',async()=>{
  const task=await api(`/api/leads/${lead.caseId}/research`,'POST',{});await prioritize(task.jobId);
  const result=await waitJob(task.jobId);assert.equal(result.status,'complete',result.result);
  const row=(await pool.query('SELECT research_status,research FROM businesses WHERE id=$1',[lead.businessId])).rows[0];assert.equal(row.research_status,'complete');
  const research=JSON.parse(row.research);return `Completed; ${research.sources.length} sources; ${research.gaps.join(' ')}`;
 });
 await check('Draft generation, editing, queue and cancellation',async()=>{
  const draft=await api(`/api/leads/${lead.caseId}/draft`,'POST',{});
  await api(`/api/messages/${draft.id}`,'PUT',{subject:'Scout live QA — do not send',body:'Temporary verification fixture. This message is cancelled without sending.'});
  await api(`/api/messages/${draft.id}/queue`,'POST',{});
  let row=(await pool.query('SELECT status FROM messages WHERE id=$1',[draft.id])).rows[0];assert.equal(row.status,'queued');
  await api(`/api/messages/${draft.id}/cancel`,'POST',{});
  row=(await pool.query('SELECT status FROM messages WHERE id=$1',[draft.id])).rows[0];assert.equal(row.status,'cancelled');
  return 'Campaign stayed in draft throughout; no SMTP delivery attempted';
 });
 }
 await check('Live desktop routes and mobile layout',async()=>{
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1050}});
  await context.addCookies([{name:'scout_session',value:cookie.split('=')[1],url:base,httpOnly:true,secure:true,sameSite:'Strict'}]);
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.getByRole('heading',{name:'A clearer path to your next client.'}).waitFor();
  for(const name of ['Discover','Prospects','Outreach','Inbox']) {await page.locator('nav').getByRole('button',{name,exact:true}).click();await page.waitForTimeout(250);}
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/live-settings.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.locator('nav').getByRole('button',{name:'Overview',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.screenshot({path:'test-results/live-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  await browser.close();browser=null;
 });
 if(campaign) await check('Live local-business discovery provider',async()=>{
  const task=await api(`/api/campaigns/${campaign.id}/discover`,'POST',{});await prioritize(task.jobId);
  const result=await waitJob(task.jobId);assert.notEqual(result.status,'failed',result.result);
  const data=JSON.parse(result.result);assert(!(data.warnings||[]).length,JSON.stringify(data.warnings));return data.summary;
 });
 for(const sender of initial.senders) await check(`Live inbox sync (${sender.email})`,async()=>{
  const prior=new Set((await pool.query('SELECT id FROM jobs')).rows.map(x=>x.id));
  const task=await api(`/api/senders/${sender.id}/sync`,'POST',{});if(!prior.has(task.jobId))ownedJobs.add(task.jobId);await prioritize(task.jobId);
  const result=await waitJob(task.jobId);assert.equal(result.status,'complete',result.result);return result.result;
 });
} finally {
 await browser?.close();
 // Delete only temporary records belonging to the campaigns created by this run.
 for(const campaignId of tempCampaigns) {
  const client=await pool.connect();try {await client.query('BEGIN');
   const businesses=(await client.query('SELECT business_id FROM cases WHERE campaign_id=$1',[campaignId])).rows.map(x=>x.business_id);
   await client.query('DELETE FROM activities WHERE case_id IN (SELECT id FROM cases WHERE campaign_id=$1)',[campaignId]);
   await client.query('DELETE FROM messages WHERE case_id IN (SELECT id FROM cases WHERE campaign_id=$1)',[campaignId]);
   await client.query('DELETE FROM cases WHERE campaign_id=$1',[campaignId]);
   await client.query("DELETE FROM jobs WHERE payload::jsonb->>'campaignId'=$1",[campaignId]);
   for(const id of businesses){
    const referenced=(await client.query('SELECT id FROM cases WHERE business_id=$1',[id])).rowCount;
    if(!referenced){await client.query("DELETE FROM jobs WHERE payload::jsonb->>'businessId'=$1",[id]);await client.query('DELETE FROM businesses WHERE id=$1',[id]);}
   }
   await client.query('DELETE FROM campaigns WHERE id=$1',[campaignId]);await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');console.log('Temporary record cleanup failed:',e.code||e.message);}finally{client.release();}
 }
 for(const id of ownedJobs) await pool.query("DELETE FROM jobs WHERE id=$1 AND status IN ('complete','failed','partial')",[id]);
 if(cookie) await check('Logout and session revocation',async()=>{await api('/api/auth/logout','POST',{});await api('/api/state','GET',null,401);});
 await pool.end();mkdirSync('test-results',{recursive:true});writeFileSync(process.argv.includes('--discovery-only') ? 'test-results/live-discovery-recheck.json' : 'test-results/live-check.json',JSON.stringify(report,null,2));
 console.log(`RESULT ${report.filter(x=>x.passed).length}/${report.length} checks passed. Temporary campaign records cleaned up.`);
}
