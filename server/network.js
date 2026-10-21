import https from 'node:https';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
export function publicAddress(address) { try { let ip = ipaddr.parse(address); if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address(); return ip.range() === 'unicast'; } catch { return false; } }
export function webUrl(value) { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) throw new Error('Use a public HTTP or HTTPS website URL.'); return u; }
export async function safeFetch(value, { redirects = 5, maxBytes = 1500000, signal = AbortSignal.timeout(10000) } = {}) {
  const u = webUrl(value); const host = u.hostname.replace(/^\[|\]$/g, '');
  signal.throwIfAborted();
  const addresses = await Promise.race([lookup(host, { all: true }), new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Website request timed out.')), { once: true }))]);
  if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw new Error('Private or local network addresses cannot be researched.');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers: { 'User-Agent': 'ScoutResearch/1.0 (business website research)', Accept: 'text/html,text/plain;q=0.9' }, lookup: (_host, options, cb) => options?.all ? cb(null, [address]) : cb(null, address.address, address.family), timeout: 10000, signal }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); if (!redirects) return reject(new Error('Too many redirects.')); safeFetch(new URL(res.headers.location, u).href, { redirects: redirects - 1, maxBytes, signal }).then(resolve, reject); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error(`Website returned HTTP ${res.statusCode}.`)); }
      const mime = res.headers['content-type'] || '';
      if (mime && !/text\/|application\/(json|xhtml\+xml)/i.test(mime)) { res.resume(); return reject(new Error('This address is not a readable webpage.')); }
      let bytes = 0; const chunks = []; res.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) res.destroy(new Error('Page exceeds the research size limit.')); else chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => resolve({ url: u.href, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Website request timed out.'))); req.on('error', reject);
  });
}
// Lightweight reachability probe: confirms a URL responds without downloading the page body.
export async function checkUrl(value, { redirects = 5, signal = AbortSignal.timeout(10000) } = {}) {
  const u = webUrl(value); const host = u.hostname.replace(/^\[|\]$/g, '');
  signal.throwIfAborted();
  const addresses = await Promise.race([lookup(host, { all: true }), new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Website request timed out.')), { once: true }))]);
  if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw new Error('Private or local network addresses cannot be checked.');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers: { 'User-Agent': 'ScoutResearch/1.0 (business website research)', Accept: 'text/html,*/*;q=0.8' }, lookup: (_host, options, cb) => options?.all ? cb(null, [address]) : cb(null, address.address, address.family), timeout: 10000, signal }, res => {
      const status = res.statusCode; res.resume();
      if (status >= 300 && status < 400 && res.headers.location) { if (!redirects) return resolve({ status, url: u.href }); return checkUrl(new URL(res.headers.location, u).href, { redirects: redirects - 1, signal }).then(resolve, reject); }
      resolve({ status, url: u.href });
    });
    req.on('timeout', () => req.destroy(new Error('Website request timed out.'))); req.on('error', reject);
  });
}
export function coordinates(input) {
  const patterns = [/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, /(?:[?&](?:q|query|ll)=|^)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/];
  for (const pattern of patterns) { const match = decodeURIComponent(input).match(pattern); if (match) { const lat = +match[1], lng = +match[2]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }; } }
  return null;
}
export async function resolveLocation(value) {
  const direct = coordinates(value); if (direct) return direct;
  const u = webUrl(value); if (!/(^|\.)(google\.[a-z.]+|goo\.gl)$/.test(u.hostname)) throw new Error('Paste a Google Maps link or enter latitude,longitude.');
  const result = await safeFetch(u.href); const found = coordinates(result.url);
  if (!found) throw new Error('This link does not expose a precise location. Paste a Maps link containing coordinates, or enter latitude,longitude.');
  return found;
}
