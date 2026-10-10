import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import { all, one, run, setting, decrypt, now, id, activity, transaction } from './db.js';
import { validEmail } from './research.js';
export function transport(sender) {
  return nodemailer.createTransport({
    host: sender.host,
    port: sender.port,
    secure: sender.port === 465,
    requireTLS: sender.port !== 465,
    auth: {
      user: sender.email,
      pass: decrypt(sender.secret)
    },
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000,
    logger: false,
    debug: false
  });
}
export async function verifySender(sender) {
  const mail = transport(sender);
  try {
    await mail.verify();
    await run("UPDATE senders SET verified=1,health='SMTP connected' WHERE id=?", sender.id);
    return {
      ok: true
    };
  } catch (e) {
    const error = e.code === 'EAUTH' ? 'Gmail rejected these credentials. Check the email and app password.' : `SMTP connection failed (${e.code || 'network error'}). Check host, port, and network access.`;
    await run('UPDATE senders SET verified=0,health=? WHERE id=?', error, sender.id);
    throw new Error(error);
  } finally {
    mail.close();
  }
}
export async function localClock(date = new Date(), timezone) {
  timezone ??= await setting('timezone', 'Asia/Kolkata');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short'
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: +p.hour,
    weekday: p.weekday
  };
}
export async function eligibility(message) {
  const c = await one('SELECT c.*,b.suppressed,b.email,b.id AS business_id,ca.status AS campaign_status FROM cases c JOIN businesses b ON b.id=c.business_id JOIN campaigns ca ON ca.id=c.campaign_id WHERE c.id=?', message.case_id);
  if (!c) return 'Lead no longer exists.';
  if (c.suppressed || (await one('SELECT email FROM suppression WHERE email=?', message.recipient.toLowerCase()))) return 'Recipient has opted out or is suppressed.';
  if (!validEmail(message.recipient) || !message.subject.trim() || !message.body.trim() || /\{\{.+?\}\}/.test(message.body + message.subject)) return 'Message has missing or invalid content.';
  if (message.kind === 'initial') {
    if (c.campaign_status !== 'active') return 'Campaign is paused.';
    if (['Replied', 'Interested', 'Proposal sent', 'Won', 'Lost'].includes(c.stage)) return 'This lead has already progressed beyond initial outreach.';
    const duplicate = await one("SELECT m.id FROM messages m JOIN cases cs ON cs.id=m.case_id WHERE m.id<>? AND m.direction='outbound' AND m.status IN ('sending','sent','uncertain') AND (lower(m.recipient)=? OR cs.business_id=?) LIMIT 1", message.id, message.recipient.toLowerCase(), c.business_id);
    if (duplicate) return 'This business or recipient has already been contacted.';
  }
  return null;
}
export async function reserveMessage(messageId, date = new Date()) {
  return await transaction(async () => {
    const m = await one("SELECT * FROM messages WHERE id=? AND status='queued'", messageId);
    if (!m) return null;
    const sender = await one('SELECT * FROM senders WHERE id=?', m.sender_id);
    if (!sender?.verified) return null;
    const reason = await eligibility(m);
    if (reason) {
      if (reason !== 'Campaign is paused.') await run("UPDATE messages SET status='blocked',error=? WHERE id=?", reason, m.id);
      return null;
    }
    const clock = await localClock(date);
    const allowedDays = await setting('days', 'Mon,Tue,Wed,Thu,Fri');
    if (clock.hour < +(await setting('start_hour', '9')) || clock.hour >= +(await setting('end_hour', '18')) || !allowedDays.split(',').includes(clock.weekday)) return null;
    // Count all outgoing mail, including manual replies. This keeps the cap unambiguous.
    const count = (await one("SELECT count(*) AS n FROM messages WHERE reserved_day=? AND status IN ('sending','sent','uncertain')", clock.day)).n;
    if (count >= +(await setting('daily_limit', '5'))) return null;
    const last = await one("SELECT sent_at FROM messages WHERE sender_id=? AND status IN ('sent','uncertain','sending') AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1", sender.id);
    if (last && date.getTime() - new Date(last.sent_at).getTime() < +(await setting('spacing_minutes', '30')) * 60000) return null;
    await run("UPDATE messages SET status='sending',reserved_day=?,sent_at=?,error=NULL WHERE id=?", clock.day, date.toISOString(), m.id);
    return {
      message: m,
      sender
    };
  });
}
export async function sendNext() {
  const candidates = await all("SELECT id FROM messages WHERE status='queued' ORDER BY created_at LIMIT 50");
  for (const candidate of candidates) {
    const reserved = await reserveMessage(candidate.id);
    if (!reserved) continue;
    const {
      message: m,
      sender
    } = reserved;
    const mail = transport(sender);
    const messageId = `<${m.id}@${sender.email.split('@')[1]}>`;
    try {
      // Re-check immediately before handing the message to the SMTP transport.
      const reason = await eligibility(m);
      if (reason) {
        await run("UPDATE messages SET status='blocked',error=?,reserved_day=NULL,sent_at=NULL WHERE id=?", reason, m.id);
        return;
      }
      const info = await mail.sendMail({
        from: {
          name: sender.name,
          address: sender.email
        },
        to: {
          address: m.recipient
        },
        subject: m.subject,
        text: m.body,
        messageId,
        inReplyTo: m.in_reply_to || undefined,
        references: m.in_reply_to ? [m.in_reply_to] : undefined,
        headers: {
          'List-Unsubscribe': `<mailto:${sender.email}?subject=Unsubscribe>`
        }
      });
      if (!info.accepted?.length) throw Object.assign(new Error('Recipient rejected'), {
        responseCode: 550
      });
      await run("UPDATE messages SET status='sent',message_id=?,sent_at=?,error=NULL WHERE id=?", messageId, now(), m.id);
      if (m.kind === 'initial') await run("UPDATE cases SET stage='Contacted' WHERE id=? AND stage IN ('New','Qualified')", m.case_id);
      await activity(m.case_id, 'email', `Email accepted by SMTP: ${m.subject}`);
    } catch (e) {
      const definite = e.code === 'EAUTH' || e.code === 'EENVELOPE' || e.responseCode >= 400 && e.responseCode <= 599;
      const status = definite ? 'failed' : 'uncertain';
      const error = definite ? `SMTP rejected the message (${e.responseCode || e.code}). Review before requeueing.` : 'Delivery is uncertain after a connection problem. Check your sent mailbox before sending again.';
      await run('UPDATE messages SET status=?,error=? WHERE id=?', status, error, m.id);
      if (e.code === 'EAUTH') await run("UPDATE senders SET verified=0,health='Authentication failed; sending paused' WHERE id=?", sender.id);
      if (e.code === 'EENVELOPE' && e.responseCode >= 500) await suppress(m.recipient, 'Recipient rejected by SMTP', m.case_id);
      await activity(m.case_id, 'email', error);
    } finally {
      mail.close();
    }
    return;
  }
}
export async function suppress(email, reason, caseId) {
  await transaction(async () => {
    await run('INSERT INTO suppression VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason', email.toLowerCase(), reason, now());
    await run('UPDATE businesses SET suppressed=1 WHERE lower(email)=?', email.toLowerCase());
    await run("UPDATE messages SET status='cancelled',error='Contact suppressed' WHERE lower(recipient)=? AND status IN ('queued','draft','blocked')", email.toLowerCase());
    if (caseId) await activity(caseId, 'suppressed', reason);
  });
}
export async function hasImportedMessage(senderId, messageId) {
  return !!(await one("SELECT id FROM messages WHERE sender_id=? AND direction='inbound' AND message_id=?", senderId, messageId));
}
export async function syncInbox(sender) {
  if (!sender.imap_host) throw new Error('Configure an IMAP host first.');
  const client = new ImapFlow({
    host: sender.imap_host,
    port: 993,
    secure: true,
    auth: {
      user: sender.email,
      pass: decrypt(sender.secret)
    },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000
  });
  let added = 0;
  const deadline = setTimeout(() => client.close(), 120000);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const ids = await client.search({
        since: new Date(Date.now() - 30 * 86400000)
      }, {
        uid: true
      });
      if (ids.length) for await (const item of client.fetch(ids.slice(-100), {
        source: true,
        uid: true
      }, {
        uid: true
      })) {
        if (!item.source || item.source.length > 3000000) continue;
        const parsed = await simpleParser(item.source, {
          skipHtmlToText: true,
          skipTextToHtml: true
        });
        const messageId = parsed.messageId || `<imap-${createHash('sha256').update(item.source).digest('hex')}@local>`;
        if (await hasImportedMessage(sender.id, messageId)) continue;
        const from = parsed.from?.value?.[0]?.address?.toLowerCase();
        if (!from) continue;
        const references = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references])].filter(Boolean);
        let parent;
        for (const ref of references) {
          parent = await one("SELECT * FROM messages WHERE message_id=? AND sender_id=? AND direction='outbound'", ref, sender.id);
          if (parent) break;
        }
        if (!parent) {
          const matches = await all("SELECT * FROM messages WHERE lower(recipient)=? AND sender_id=? AND direction='outbound' AND status='sent' ORDER BY sent_at DESC", from, sender.id);
          if (new Set(matches.map(m => m.case_id)).size === 1) parent = matches[0];
        }
        // Only import conversations with known prospects, never the entire personal inbox.
        if (!parent) continue;
        const body = (parsed.text || 'This message contains HTML only. View it in your mailbox.').slice(0, 30000);
        await run('INSERT INTO messages(id,case_id,sender_id,recipient,subject,body,direction,status,kind,message_id,in_reply_to,sent_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id(), parent.case_id, sender.id, from, (parsed.subject || '(No subject)').slice(0, 250), body, 'inbound', 'received', 'reply', messageId, parent.message_id, parsed.date?.toISOString() || now(), now());
        await run("UPDATE cases SET stage='Replied' WHERE id=? AND stage IN ('New','Qualified','Contacted')", parent.case_id);
        await run("UPDATE messages SET status='cancelled',error='Reply received' WHERE case_id=? AND kind='initial' AND status='queued'", parent.case_id);
        // Inspect only the new reply, not quoted campaign text which contains an opt-out footer.
        const newText = body.split(/\n(?:On .+wrote:|From:|>)/i)[0].slice(0, 2000);
        if (/\b(unsubscribe|remove me|stop (emailing|contacting)|do not (email|contact)|don't (email|contact))\b/i.test(newText)) await suppress(from, 'Opt-out received by email', parent.case_id);
        await activity(parent.case_id, 'reply', `Reply received: ${parsed.subject || '(No subject)'}`);
        added++;
      }
    } finally {
      lock.release();
    }
    await run("UPDATE senders SET last_sync=?,health='SMTP configured · inbox synced' WHERE id=?", now(), sender.id);
    return {
      added
    };
  } catch {
    throw new Error('Inbox connection failed. Check IMAP access and the app password.');
  } finally {
    clearTimeout(deadline);
    await client.logout().catch(() => {});
  }
}
