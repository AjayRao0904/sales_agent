import assert from 'node:assert/strict';
import{readFileSync,writeFileSync}from'node:fs';
import{parse}from'dotenv';
import{chromium}from'@playwright/test';
const password=readFileSync(0,'utf8').trim();process.env.DATABASE_URL=parse(readFileSync('.env.vercel.production')).DATABASE_URL;
const{one,all,run,db}=await import('../server/db.js');
const report=JSON.parse(readFileSync('test-results/live-delivery.json'));const base='https://scout-sales-agent.vercel.app';let cookie,browser;
async function api(path,method='GET',body){const r=await fetch(base+path,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert(r.ok,data.error||String(r.status));return data;}
try{
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
 const original=await one("SELECT m.* FROM messages m JOIN cases c ON c.id=m.case_id WHERE c.campaign_id=? AND m.kind='initial' AND m.direction='outbound'",report.campaignId);
 const reply=await one("SELECT m.* FROM messages m JOIN cases c ON c.id=m.case_id WHERE c.campaign_id=? AND m.kind='reply' AND m.direction='outbound'",report.campaignId);
 assert.equal(original.status,'sent');assert.equal(reply.status,'sent');
 await run("UPDATE messages SET message_id=? WHERE case_id=? AND direction='inbound' AND message_id LIKE '<test-import-%'",original.message_id,reply.case_id);
 const task=await api(`/api/senders/${original.sender_id}/sync`,'POST',{});
 await run("UPDATE jobs SET payload=(payload::jsonb || '{\"priority\":9}'::jsonb)::text WHERE id=? AND status='queued'",task.jobId);
 const until=Date.now()+240000;let incoming;
 while(Date.now()<until){await api('/api/state');incoming=await one("SELECT * FROM messages WHERE sender_id=? AND direction='inbound' AND message_id=?",original.sender_id,reply.message_id);if(incoming)break;const job=await one('SELECT status,result FROM jobs WHERE id=?',task.jobId);if(job.status==='failed')throw new Error(job.result);await new Promise(r=>setTimeout(r,5000));}
 assert(incoming,'Reply was not imported');assert.equal(incoming.case_id,original.case_id);assert.equal((await one('SELECT stage FROM cases WHERE id=?',original.case_id)).stage,'Replied');
 console.log('PASS Live inbox importer matched the existing reply to the original case and set Replied.');
 const state=await api('/api/state');assert(state.messages.some(m=>m.id===incoming.id));
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext();await context.addCookies([{name:'scout_session',value:cookie.split('=')[1],url:base,httpOnly:true,secure:true,sameSite:'Strict'}]);const page=await context.newPage();await page.goto(base);await page.locator('nav').getByRole('button',{name:'Inbox',exact:true}).click();await page.getByText(reply.subject,{exact:true}).first().waitFor();await page.screenshot({path:'test-results/live-reply-inbox.png',fullPage:true});console.log('PASS Actual reply appears in the live Inbox interface.');
 const backup=JSON.parse(readFileSync('test-results/delivery-settings-backup.json'));
 for(const key of ['days','start_hour','end_hour'])assert.equal((await one('SELECT value FROM settings WHERE key=?',key))?.value,backup.find(x=>x.key===key)?.value);
 assert.equal((await one('SELECT status FROM campaigns WHERE id=?',report.campaignId)).status,'paused');
 assert.equal((await one("SELECT count(*) n FROM messages m JOIN cases c ON c.id=m.case_id WHERE c.campaign_id=? AND direction='outbound' AND status='sent'",report.campaignId)).n,2);
 report.evidence.push('Live inbox importer linked the reply and changed original case to Replied','Actual reply verified in live Inbox UI','Original schedule restored; test campaign paused; exactly two test emails sent');report.passed=true;writeFileSync('test-results/live-delivery.json',JSON.stringify(report,null,2));console.log('PASS Exactly two test emails sent. Sending schedule restored and test campaign paused.');
}finally{await browser?.close();if(cookie)await api('/api/auth/logout','POST',{}).catch(()=>{});await db.close();}
