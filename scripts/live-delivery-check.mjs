import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
const password=readFileSync(0,'utf8').trim();
process.env.DATABASE_URL=parse(readFileSync('.env.vercel.production')).DATABASE_URL;
const {one,all,run,transaction,hashPassword,decrypt,db,now}=await import('../server/db.js');
const base='https://scout-sales-agent.vercel.app', marker=randomUUID().slice(0,8);
const keys=['days','start_hour','end_hour'];
let cookie,campaignId,changed=false;const evidence=[];
const backup=await all('SELECT key,value FROM settings');
async function api(path,method='GET',body){const r=await fetch(base+path,{method,signal:AbortSignal.timeout(60000),headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw new Error(`${path}: ${data.error||r.status}`);return data;}
function pass(name){evidence.push(name);console.log('PASS '+name);}
async function waitFor(check,label,timeout=240000){const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;await api('/api/state');await new Promise(r=>setTimeout(r,5000));}throw new Error(`Timed out: ${label}`);}
async function waitSent(id){return waitFor(async()=>{const m=await one('SELECT * FROM messages WHERE id=?',id);if(['failed','blocked','uncertain'].includes(m.status))throw new Error(m.error||m.status);return m.status==='sent'?m:null;},'SMTP send');}
async function receive(sender,messageId){const client=new ImapFlow({host:sender.imap_host,port:993,secure:true,auth:{user:sender.email,pass:decrypt(sender.secret)},logger:false,connectionTimeout:15000,socketTimeout:30000});try{await client.connect();await client.mailboxOpen('INBOX',{readOnly:true});const end=Date.now()+90000;while(Date.now()<end){const ids=await client.search({header:{'message-id':messageId}},{uid:true});if(ids.length){const item=await client.fetchOne(ids.at(-1),{source:true},{uid:true});return await simpleParser(item.source);}await new Promise(r=>setTimeout(r,5000));}throw new Error('Test message not found in receiving inbox');}finally{await client.logout().catch(()=>{});}}
try{
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
 const a=await one('SELECT * FROM senders WHERE email=?','ajayrao0904@gmail.com'), b=await one('SELECT * FROM senders WHERE email=?','adityabssr4@gmail.com');assert(a?.verified&&b?.verified);
 await transaction(async()=>{
  assert.equal((await one("SELECT count(*) n FROM campaigns WHERE status='active'")).n,0,'Other campaigns must be inactive');
  assert.equal((await one("SELECT count(*) n FROM messages WHERE status IN ('queued','sending')")).n,0,'Other sending must be idle');
  for(const [key,value]of Object.entries({days:'Mon,Tue,Wed,Thu,Fri,Sat,Sun',start_hour:'0',end_hour:'24'}))await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,value);
 });changed=true;
 mkdirSync('test-results',{recursive:true});writeFileSync('test-results/delivery-settings-backup.json',JSON.stringify(backup.filter(x=>keys.includes(x.key))));
 const campaign=await api('/api/campaigns','POST',{name:`[TEST] Email delivery ${marker}`,location:'',lat:null,lng:null,radius:100,categories:['cafe'],sender_id:a.id,price_min:0,price_max:0,currency:'INR',scope:'User-authorized email delivery test only',auto_queue:false});campaignId=campaign.id;
 const businessId=randomUUID(),caseId=randomUUID(),firstId=randomUUID();
 const subject=`[Scout test ${marker}] Email delivery check`;
 await transaction(async()=>{
  await run('INSERT INTO businesses(id,name,category,email,research_status,created_at) VALUES(?,?,?,?,?,?)',businessId,`[TEST] Aditya inbox ${marker}`,'test',b.email,'complete',now());
  await run('INSERT INTO cases(id,campaign_id,business_id,created_at) VALUES(?,?,?,?)',caseId,campaignId,businessId,now());
  await run('INSERT INTO messages(id,case_id,sender_id,recipient,subject,body,created_at) VALUES(?,?,?,?,?,?,?)',firstId,caseId,a.id,b.email,subject,'This is an authorized Scout live-system test between your connected accounts. It checks SMTP delivery and reply tracking. No action is needed; an automated test reply will follow.',now());
 });
 await api(`/api/campaigns/${campaignId}/status`,'POST',{status:'active'});
 await api(`/api/messages/${firstId}/queue`,'POST',{});
 const sent=await waitSent(firstId);pass('Initial test email sent through the live Vercel queue');
 const received=await receive(b,sent.message_id);assert.equal(received.subject,subject);assert.equal(received.from.value[0].address.toLowerCase(),a.email);pass('Actual delivery confirmed in the second Gmail inbox');
 // Seed the actual received email into a second test case to exercise Scout’s reply API.
 // The normal importer only imports existing prospect conversations; this is a new self-test conversation.
 const secondBusiness=randomUUID(),secondCase=randomUUID(),inboundId=randomUUID();
 await transaction(async()=>{
  await run('INSERT INTO businesses(id,name,category,email,research_status,created_at) VALUES(?,?,?,?,?,?)',secondBusiness,`[TEST] Ajay inbox ${marker}`,'test',a.email,'complete',now());
  await run('INSERT INTO cases(id,campaign_id,business_id,stage,created_at) VALUES(?,?,?,?,?)',secondCase,campaignId,secondBusiness,'Replied',now());
  await run('INSERT INTO messages(id,case_id,sender_id,recipient,subject,body,direction,status,kind,message_id,sent_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',inboundId,secondCase,b.id,a.email,received.subject,received.text||'', 'inbound','received','reply',sent.message_id,now(),now());
 });
 const reply=await api(`/api/messages/${inboundId}/reply`,'POST',{body:`Scout test ${marker}: delivery confirmed. This authorized test reply verifies CRM threading and the Replied stage.`});
 await api(`/api/messages/${reply.id}/queue`,'POST',{});
 const replySent=await waitSent(reply.id);pass('Reply drafted through the live reply API and sent from the second account');
 const actualReply=await receive(a,replySent.message_id);assert.equal(actualReply.inReplyTo,sent.message_id);pass('Reply delivered to the first Gmail inbox with the correct thread header');
 const sync=await api(`/api/senders/${a.id}/sync`,'POST',{});
 await run("UPDATE jobs SET payload=(payload::jsonb || '{\"priority\":9}'::jsonb)::text WHERE id=? AND status='queued'",sync.jobId);
 await waitFor(async()=>{const job=await one('SELECT status,result FROM jobs WHERE id=?',sync.jobId);if(job.status==='failed')throw new Error(job.result);return job.status==='complete';},'Live inbox synchronization');
 const inbound=await one("SELECT id,case_id FROM messages WHERE message_id=? AND direction='inbound'",replySent.message_id);
 assert(inbound,'Reply should be imported automatically');assert.equal(inbound.case_id,caseId);assert.equal((await one('SELECT stage FROM cases WHERE id=?',caseId)).stage,'Replied');pass('Live inbox importer linked the reply and changed the original case to Replied');
 const state=await api('/api/state');assert(state.messages.some(m=>m.id===inbound.id));pass('Imported reply visible in the live dashboard API');
}catch(e){console.log('FAIL '+e.message);process.exitCode=1;}
finally{
 if(campaignId){await run("UPDATE campaigns SET status='paused' WHERE id=?",campaignId);await run("UPDATE messages SET status='cancelled' WHERE case_id IN (SELECT id FROM cases WHERE campaign_id=?) AND status IN ('draft','queued')",campaignId);}
 if(changed)await transaction(async()=>{for(const key of keys){const prior=backup.find(x=>x.key===key);if(prior)await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,prior.value);else await run('DELETE FROM settings WHERE key=?',key);}});
 if(cookie)await api('/api/auth/logout','POST',{}).catch(()=>{});
 mkdirSync('test-results',{recursive:true});writeFileSync('test-results/live-delivery.json',JSON.stringify({campaignId,evidence,passed:!process.exitCode,settingsRestored:changed},null,2));
 await db.close();console.log('Sending schedule restored. Test campaign paused; delivery records retained for review.');
}
