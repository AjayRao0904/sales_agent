import { findBusinessContacts, structuredBusinesses } from './contacts.js';
import { searchOpenStreetMap } from './discovery.js';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import { safeFetch, webUrl } from './network.js';
import { all, one, run, now, id, activity, setting, decrypt, transaction } from './db.js';
export const validEmail = value => /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i.test(value) && value.length < 255;
export function extractPage(html, url) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg').remove();
  const emails = new Set();
  const phones = new Set();
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.startsWith('mailto:')) {
      try {
        decodeURIComponent(href.slice(7).split('?')[0]).split(/[;,]/).forEach(v => emails.add(v.trim().toLowerCase()));
      } catch {}
    }
    if (href.startsWith('tel:')) phones.add(href.slice(4).trim());
    try {
      const next = new URL(href, url);
      if (next.origin === new URL(url).origin && /contact|about|booking|menu|services/i.test(next.pathname)) links.add(next.href.split('#')[0]);
    } catch {}
  });
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  for (const value of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) emails.add(value.toLowerCase());
  for (const value of text.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]){2,3}\d{3,4}/g) || []) if (value.replace(/\D/g, '').length >= 8 && value.replace(/\D/g, '').length <= 15) phones.add(value);
  return {
    title: $('title').text().trim().slice(0, 160),
    description: ($('meta[name="description"]').attr('content') || '').slice(0, 600),
    excerpt: text.slice(0, 1800),
    emails: [...emails].filter(x => validEmail(x) && !/example\.|sentry\.|wixpress\.|\.png$|\.jpg$/i.test(x)),
    phones: [...phones].slice(0, 10),
    links: [...links].slice(0, 4)
  };
}
export function features(category) {
  if (/restaurant|cafe|fast_food|bakery|food/.test(category)) return ['a mobile-friendly menu', 'opening hours and directions', 'a customer enquiry form'];
  if (/salon|beauty|hair/.test(category)) return ['a service showcase', 'a gallery of your work', 'an appointment enquiry form'];
  return ['a product or service showcase', 'store details and directions', 'a customer enquiry form'];
}
export async function researchBusiness(businessId, options = {}) {
  const b = await one('SELECT * FROM businesses WHERE id=?', businessId);
  if (!b) throw new Error('Business not found.');
  await run("UPDATE businesses SET research_status='researching' WHERE id=?", b.id);
  const sources = [];
  const emails = [];
  const phones = [];
  const gaps = [];
  const observations = [];
  let contactLookup = b.research ? JSON.parse(b.research).contact_lookup || null : null;
  if (contactLookup?.match && contactLookup.match.website !== b.website) contactLookup = null;
  if (!b.website && (!b.email || !b.phone)) {
    const campaign = await one('SELECT ca.name FROM cases cs JOIN campaigns ca ON ca.id=cs.campaign_id WHERE cs.business_id=? LIMIT 1', b.id);
    const nearby = b.lat != null ? await one("SELECT address FROM businesses WHERE address<>'' AND lat IS NOT NULL ORDER BY abs(lat-?)+abs(lng-?) LIMIT 1", b.lat, b.lng) : null;
    const postal = nearby?.address?.match(/\b\d{5,6}\b/)?.[0] || '';
    contactLookup = await findBusinessContacts(b, `${campaign?.name || ''} ${postal}`, options);
    if (contactLookup.match) {
      const match = contactLookup.match;
      b.website = match.website;
      b.address ||= match.address;
      b.phone ||= match.phone;
      if (!b.email && validEmail(match.email)) b.email = match.email;
      await run('UPDATE businesses SET website=?,address=?,phone=?,email=? WHERE id=?', b.website, b.address, b.phone, b.email, b.id);
      sources.push({
        url: match.source,
        title: 'Matched business website',
        excerpt: match.confidence,
        observed_at: now()
      });
      if (match.phone) phones.push({
        value: match.phone,
        source: match.source,
        confidence: match.confidence
      });
      if (validEmail(match.email)) emails.push({
        value: match.email,
        source: match.source,
        confidence: match.confidence
      });
    } else gaps.push(...contactLookup.notes);
  }
  if (b.source_url) sources.push({
    url: b.source_url,
    title: 'Business listing',
    observed_at: now(),
    excerpt: `${b.name} · ${b.category} · ${b.address}`
  });
  if (b.email) emails.push({
    value: b.email,
    source: contactLookup?.match?.source || b.source_url,
    confidence: 'Published business contact'
  });
  if (b.phone) phones.push({
    value: b.phone,
    source: contactLookup?.match?.source || b.source_url
  });
  if (b.website) {
    const origin = webUrl(b.website).origin;
    let robots;
    try {
      const r = await safeFetch(`${origin}/robots.txt`, {
        maxBytes: 150000
      });
      robots = robotsParser(`${origin}/robots.txt`, r.text);
    } catch (e) {
      if (!/HTTP 404|HTTP 410/.test(e.message)) gaps.push('Could not confirm website crawl permissions; website research was skipped.');
    }
    const canCrawl = robots || !gaps.length;
    const urls = [b.website];
    for (let i = 0; canCrawl && i < urls.length && i < 5; i++) {
      if (robots?.isAllowed(urls[i], 'ScoutResearch') === false) {
        gaps.push('A page was excluded by website crawl preferences.');
        continue;
      }
      try {
        const page = await safeFetch(urls[i], {
          maxBytes: 6000000
        });
        if (new URL(page.url).origin !== origin) {
          gaps.push('Website redirected to a different origin; review its URL before research.');
          continue;
        }
        const data = extractPage(page.text, page.url);
        const branchStructured = structuredBusinesses(page.text).find(item => item.geo);
        if (branchStructured) {
          data.phones = typeof branchStructured.telephone === 'string' && branchStructured.telephone.trim() ? [branchStructured.telephone.trim()] : [];
          data.emails = typeof branchStructured.email === 'string' && validEmail(branchStructured.email.replace(/^mailto:/i, '')) ? [branchStructured.email.replace(/^mailto:/i, '')] : [];
        }
        sources.push({
          url: page.url,
          title: data.title || 'Business website',
          excerpt: data.description || data.excerpt,
          observed_at: now()
        });
        for (const [pattern, label] of [[/\bcatering\b/i, 'catering'], [/\b(takeaway|takeout)\b/i, 'takeaway orders'], [/\bdelivery\b/i, 'delivery'], [/\b(reservations?|book a table)\b/i, 'table reservations'], [/\bappointments?\b/i, 'appointments'], [/\bwholesale\b/i, 'wholesale services']]) {
          if (pattern.test(data.excerpt)) observations.push({
            detail: label,
            source: page.url
          });
        }
        data.emails.forEach(value => emails.push({
          value,
          source: page.url,
          confidence: 'Published on business website'
        }));
        data.phones.forEach(value => phones.push({
          value,
          source: page.url
        }));
        if (!i) urls.push(...data.links.filter(url => url !== b.website));
      } catch (e) {
        gaps.push(e.message);
      }
    }
  } else gaps.push('No website found in checked sources.');
  const uniqueEmails = [...new Map(emails.map(e => [e.value, e])).values()];
  const bestEmail = uniqueEmails.find(e => /^(hello|info|contact|enquir|office|sales)/.test(e.value)) || uniqueEmails[0];
  if (!phones.length) gaps.push('No verified public phone number found for this business location.');
  if (!bestEmail) gaps.push('No verified public business email found. This recipient will be skipped for email outreach.');
  const profile = {
    contact_lookup: contactLookup || {
      checked: b.website ? [{
        url: b.website,
        matched: true
      }] : [],
      notes: [],
      method: 'Existing business website research'
    },
    observations: [...new Map(observations.map(o => [o.detail, o])).values()],
    summary: `${b.name} is listed as ${b.category.replaceAll('_', ' ')}${b.address ? ` at ${b.address}` : ''}.`,
    sources,
    emails: uniqueEmails,
    phones: [...new Map(phones.map(p => [p.value, p])).values()],
    suggestions: features(b.category),
    gaps: [...new Set(gaps)],
    researched_at: now(),
    method: 'Public-source extraction and evidence-based templates'
  };
  await run('UPDATE businesses SET research=?,research_status=?,email=?,phone=? WHERE id=?', JSON.stringify(profile), 'complete', b.email || bestEmail?.value || '', b.phone || phones[0]?.value || '', b.id);
  for (const c of await all('SELECT id FROM cases WHERE business_id=?', b.id)) await activity(c.id, 'research', 'Research completed. Sources and missing details saved.');
  return profile;
}
export async function buildDraft(b, c, sender) {
  if (!c.scope || c.price_min == null || c.price_max == null || c.price_min > c.price_max) throw new Error('Set the campaign service scope and price range first.');
  if (b.research_status !== 'complete') throw new Error('Research this business before drafting an email.');
  if (!validEmail(b.email)) throw new Error('Add a valid public business email first.');
  const label = b.category.replaceAll('_', ' ');
  const amount = new Intl.NumberFormat('en', {
    maximumFractionDigits: 2
  });
  const subject = `A website idea for ${b.name}`;
  const profile = b.research ? JSON.parse(b.research) : {};
  const observed = profile.observations?.[0];
  const opening = observed ? `I noticed ${observed.detail} mentioned on your website while researching ${b.name}.` : `I came across your ${label}${b.address ? ` at ${b.address}` : ''} while researching local businesses.`;
  const body = `Hi ${b.name} team,\n\n${opening}\n\nI'd love to build a personalized website for ${b.name}. Based on your business category, we could discuss ${features(b.category).join(', ')}, depending on the agreed scope.\n\nFor ${c.scope}, my range is ${c.currency} ${amount.format(c.price_min)}–${amount.format(c.price_max)}, depending on the final requirements.\n\nWould you be open to discussing a few ideas?\n\n${sender.name}\n${sender.email}${(await setting('portfolio')) ? `\n${await setting('portfolio')}` : ''}\n\nIf you'd prefer no further emails from me, just reply and let me know.`;
  return {
    subject,
    body
  };
}
export async function saveBusiness(campaignId, item) {
  return transaction(async () => {
    let b = item.provider_id ? await one('SELECT id FROM businesses WHERE provider_id=?', item.provider_id) : null;
    if (!b) {
      const candidates = await all('SELECT id,address,lat,lng FROM businesses WHERE lower(name)=?', item.name.toLowerCase());
      b = candidates.find(candidate => {
        const located = item.lat != null && item.lng != null && candidate.lat != null && candidate.lng != null;
        const nearby = located && Math.abs(item.lat - candidate.lat) < 0.00025 && Math.abs(item.lng - candidate.lng) < 0.00025;
        const sameAddress = !!item.address?.trim() && candidate.address.toLowerCase() === item.address.toLowerCase();
        return nearby || sameAddress && !located;
      });
    }
    const businessId = b?.id || id();
    if (!b) await run('INSERT INTO businesses(id,provider_id,name,category,address,lat,lng,website,email,phone,maps_url,source_url,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', businessId, item.provider_id || null, item.name, item.category || 'shop', item.address || '', item.lat ?? null, item.lng ?? null, item.website || '', item.email || '', item.phone || '', item.maps_url || '', item.source_url || '', now());
    const caseId = id();
    const result = await run('INSERT OR IGNORE INTO cases(id,campaign_id,business_id,created_at) VALUES(?,?,?,?)', caseId, campaignId, businessId, now());
    if (result.changes) await activity(caseId, 'created', 'Business added to campaign.');
    return {
      businessId,
      caseId: (await one('SELECT id FROM cases WHERE campaign_id=? AND business_id=?', campaignId, businessId)).id,
      added: !!result.changes
    };
  });
}
export async function discover(campaign, options = {}) {
  const categories = JSON.parse(campaign.categories);
  let found = [];
  let coverage;
  let added = 0;
  let warnings = [];
  let remaining = Math.max(0, 300 - (await one('SELECT count(*) AS n FROM cases WHERE campaign_id=?', campaign.id)).n);
  const persist = async items => {
    for (const item of items) {
      if (remaining <= 0) break;
      if (item.website) {
        try {
          webUrl(item.website);
        } catch {
          item.website = '';
        }
      }
      if (!validEmail(item.email || '')) item.email = '';
      if ((await saveBusiness(campaign.id, item)).added) { added++; remaining--; }
    }
  };
  const apiSecret = await setting('google_key');
  if (apiSecret) {
    const types = {
      restaurant: 'restaurant',
      cafe: 'cafe',
      fast_food: 'fast_food_restaurant',
      shop: 'store',
      salon: 'beauty_salon'
    };
    for (const category of categories) {
      const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': decrypt(apiSecret),
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.nationalPhoneNumber,places.googleMapsUri'
        },
        body: JSON.stringify({
          includedTypes: [types[category] || 'store'],
          maxResultCount: 20,
          locationRestriction: {
            circle: {
              center: {
                latitude: campaign.lat,
                longitude: campaign.lng
              },
              radius: campaign.radius
            }
          }
        })
      });
      if (!response.ok) throw new Error(`Google Places returned HTTP ${response.status}. Check the API key, billing, and Places API access.`);
      const data = await response.json();
      found.push(...(data.places || []).map(p => ({
        provider_id: `google:${p.id}`,
        name: p.displayName?.text || 'Unnamed business',
        category,
        address: p.formattedAddress,
        lat: p.location?.latitude,
        lng: p.location?.longitude,
        website: p.websiteUri || '',
        phone: p.nationalPhoneNumber || '',
        maps_url: p.googleMapsUri || '',
        source_url: p.googleMapsUri || ''
      })));
    }
    coverage = 'Google Places: up to 20 results per selected category. This search is a partial sample, not a complete business census.';
  } else {
    const toBusiness = p => {
      const t = p.tags;
      const website = t.website || t['contact:website'] || '';
      return {
        provider_id: `osm:${p.type}:${p.id}`,
        name: t.name,
        category: t.amenity || t.shop || 'shop',
        address: [t['addr:housenumber'], t['addr:street'], t['addr:city'], t['addr:postcode']].filter(Boolean).join(' '),
        lat: p.lat ?? p.center?.lat,
        lng: p.lon ?? p.center?.lon,
        website: website && !/^https?:/.test(website) ? `https://${website}` : website,
        email: (t.email || t['contact:email'] || '').split(';')[0],
        phone: t.phone || t['contact:phone'] || '',
        maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.name + ' ' + (t['addr:city'] || ''))}`,
        source_url: `https://www.openstreetmap.org/${p.type}/${p.id}`
      };
    };
    const result = await searchOpenStreetMap(campaign, {
      ...options,
      onBatch: async batch => await persist(batch.map(toBusiness)),
      onProgress: async progress => {
        const summary = `${progress.summary}. Results appear in Prospects as they arrive.`;
        await run('UPDATE campaigns SET coverage=? WHERE id=?', summary, campaign.id);
        await options.onProgress?.({
          ...progress,
          summary,
          added
        });
      }
    });
    found = result.elements;
    warnings = result.warnings;
    coverage = `OpenStreetMap: ${found.length} listings collected; ${result.completed.length}/${categories.length} categories completed. Limited to 300 listings. ${warnings.length ? 'Partial coverage: ' + warnings.join(' ') : 'Coverage varies by area.'} © OpenStreetMap contributors (ODbL).`;
  }
  if (apiSecret) await persist(found);
  await run('UPDATE campaigns SET coverage=? WHERE id=?', coverage, campaign.id);
  return {
    found: found.length,
    added,
    coverage,
    warnings,
    summary: `${added} new prospects saved from ${found.length} listings.${warnings.length ? ' Some categories need retrying. ' + warnings.join(' ') : ''}`
  };
}
