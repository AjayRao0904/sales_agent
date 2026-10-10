import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import { safeFetch, webUrl } from './network.js';
import { distanceMetres } from './discovery.js';
const normalized = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const directoryHost = /(^|\.)(facebook\.com|instagram\.com|justdial\.com|zomato\.com|swiggy\.com|tripadvisor\.[a-z.]+|yelp\.com|google\.[a-z.]+|bing\.com|duckduckgo\.com|webindia123\.com)$/;
export function structuredBusinesses(html) {
  const $ = cheerio.load(html); const found = [];
  const visit = value => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) { value.forEach(visit); return; } const types = [].concat(value['@type'] || []); if (types.some(t => /LocalBusiness|Restaurant|CafeOrCoffeeShop|Store|FoodEstablishment|HealthAndBeautyBusiness|Organization/.test(t))) found.push(value); if (value['@graph']) visit(value['@graph']); };
  $('script[type="application/ld+json"]').each((_, node) => { try { visit(JSON.parse($(node).text())); } catch {} });
  return found;
}
export function matchBusinessPage(business, html, url) {
  const $ = cheerio.load(html); const host = new URL(url).hostname;
  if (directoryHost.test(host)) return null;
  const name = normalized(business.name);
  if (name.length < 3) return null;
  const title = normalized($('h1').first().text() + ' ' + $('title').text());
  for (const item of structuredBusinesses(html)) {
    if (!normalized(item.name).includes(name) && !title.includes(name) && !normalized(host).includes(name)) continue;
    const geo = item.geo; const lat = Number(geo?.latitude), lng = Number(geo?.longitude);
    const nearby = geo && Number.isFinite(lat) && Number.isFinite(lng) && business.lat != null && business.lng != null && distanceMetres(business.lat, business.lng, lat, lng) <= 250;
    const street = item.address?.streetAddress || ''; const address = normalized(business.address);
    const exactAddress = address.length >= 16 && normalized(street).length >= 12 && address.includes(normalized(street));
    if (!nearby && !exactAddress) continue;
    return { website: url, address: [street, item.address?.addressLocality, item.address?.postalCode].filter(Boolean).join(', '), phone: typeof item.telephone === 'string' ? item.telephone.trim() : '', email: typeof item.email === 'string' ? item.email.replace(/^mailto:/i, '').trim().toLowerCase() : '', source: url, confidence: nearby ? 'Business name and branch coordinates matched within 250 m' : 'Business name and street address matched', distance: nearby ? Math.round(distanceMetres(business.lat, business.lng, lat, lng)) : null };
  }
  return null;
}
export function searchLinks(html) {
  const $ = cheerio.load(html); const urls = [];
  $('.result__a').each((_, a) => { try { const raw = new URL($(a).attr('href'), 'https://duckduckgo.com'); const url = webUrl(raw.searchParams.get('uddg') || raw.href); if (!directoryHost.test(url.hostname) && !urls.includes(url.href)) urls.push(url.href); } catch {} });
  return urls.slice(0, 5);
}
const robotsCache = new Map();
export async function crawlPage(url, fetchPage = safeFetch) {
  const origin = webUrl(url).origin;
  let record = robotsCache.get(origin);
  if (!record || Date.now() - record.time > 3600000) {
    let parser;
    try { const result = await fetchPage(`${origin}/robots.txt`, { maxBytes: 200000 }); parser = robotsParser(`${origin}/robots.txt`, result.text); }
    catch (e) { if (!/HTTP 404|HTTP 410/.test(e.message)) throw new Error('Website crawl permissions could not be confirmed.'); }
    record = { parser, time: Date.now() }; robotsCache.set(origin, record);
  }
  if (record.parser?.isAllowed(url, 'ScoutResearch') === false) throw new Error('Website excludes this page from automated research.');
  const result = await fetchPage(url, { maxBytes: 6000000 });
  if (new URL(result.url).origin !== origin) throw new Error('Website moved to another domain; its identity needs review.');
  return result;
}
let lastSearch = 0;
export async function findBusinessContacts(business, context, { fetchPage = safeFetch, search = null, candidates = [] } = {}) {
  const queries = [`"${business.name}" ${business.address || context} official contact`];
  const notes = []; const checked = [];
  const urls = [...candidates];
  if (!urls.length) for (const query of queries) {
    try {
      if (!search) { const wait = Math.max(0, 3000 - (Date.now() - lastSearch)); if (wait) await new Promise(r => setTimeout(r, wait)); lastSearch = Date.now(); }
      const result = search ? await search(query) : await fetchPage(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`);
      const links = searchLinks(result.text);
      if (!links.length) notes.push('Public web search did not return usable websites. The search service may be limiting automated requests.');
      urls.push(...links);
    } catch { notes.push('Public web search is temporarily unavailable.'); }
  }
  for (const url of [...new Set(urls)].slice(0, 5)) {
    try { const page = await crawlPage(url, fetchPage); const match = matchBusinessPage(business, page.text, page.url); checked.push({ url: page.url, matched: !!match }); if (match) return { match, checked, notes }; }
    catch (e) { checked.push({ url, error: e.message }); }
  }
  notes.push('No website could be confidently matched to this specific business location. Unverified contacts were not copied.');
  return { match: null, checked, notes };
}
