// Public instances listed at https://wiki.openstreetmap.org/wiki/Overpass_API
const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
// Search one category at a time so a slow provider query cannot discard other results.
const filters = {
  restaurant: '[amenity=restaurant]',
  cafe: '[amenity=cafe]',
  fast_food: '[amenity=fast_food]',
  shop: '[shop]',
  salon: '[shop=hairdresser]'
};
export function distanceMetres(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
function bounds(campaign) {
  const delta = campaign.radius / 6371000;
  const latDelta = delta * 180 / Math.PI;
  const ratio = Math.sin(delta) / Math.cos(campaign.lat * Math.PI / 180);
  const lngDelta = Math.asin(Math.min(1, Math.abs(ratio))) * 180 / Math.PI;
  const south = campaign.lat - latDelta,
    north = campaign.lat + latDelta;
  const west = campaign.lng - lngDelta,
    east = campaign.lng + lngDelta;
  if (south <= -90 || north >= 90 || west < -180 || east > 180) return `(around:${campaign.radius},${campaign.lat},${campaign.lng})`;
  return `(${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)})`;
}
export async function searchOpenStreetMap(campaign, {
  fetcher = fetch,
  onBatch = () => {},
  onProgress = () => {},
  retryDelay = () => new Promise(resolve => setTimeout(resolve, 1500))
} = {}) {
  const categories = JSON.parse(campaign.categories);
  const elements = new Map();
  const warnings = [];
  const completed = [];
  for (const [index, category] of categories.entries()) {
    if (elements.size >= 300) {
      warnings.push(`Result limit reached; categories not searched: ${categories.slice(index).join(', ')}.`);
      break;
    }
    let error = '';
    let succeeded = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      await onProgress({
        summary: `${attempt ? 'Retrying' : 'Searching'} ${category.replaceAll('_', ' ')} (${index + 1}/${categories.length}) · ${elements.size} listings collected`,
        warnings
      });
      const query = `[out:json][timeout:${25 + attempt * 5}];nwr${bounds(campaign)}${filters[category]}[name];out center tags 300;`;
      try {
        const response = await fetcher(`${endpoints[attempt]}?${new URLSearchParams({
          data: query
        })}`, {
          signal: AbortSignal.timeout(45000),
          headers: {
            'User-Agent': 'ScoutResearch/1.0'
          }
        });
        if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
        const data = await response.json();
        const batch = [];
        for (const item of data.elements || []) {
          if (!item.tags?.name || !['node', 'way', 'relation'].includes(item.type)) continue;
          const lat = item.lat ?? item.center?.lat,
            lng = item.lon ?? item.center?.lon;
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || distanceMetres(campaign.lat, campaign.lng, lat, lng) > campaign.radius) continue;
          const key = `${item.type}:${item.id}`;
          if (!elements.has(key) && elements.size < 300) {
            elements.set(key, item);
            batch.push(item);
          }
        }
        if (batch.length) await onBatch(batch);
        if (data.remark) throw new Error(String(data.remark).replace(/\s+/g, ' ').slice(0, 400));
        if ((data.elements || []).length >= 300) warnings.push(`${category.replaceAll('_', ' ')} reached its 300-listing provider limit; coverage is partial.`);
        completed.push(category);
        succeeded = true;
        break;
      } catch (e) {
        error = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Provider did not respond within 45 seconds' : e.message;
        if (!attempt) await retryDelay();
      }
    }
    if (!succeeded) warnings.push(`${category.replaceAll('_', ' ')}: ${error}. Any returned listings were saved.`);
  }
  const result = {
    elements: [...elements.values()],
    warnings,
    completed
  };
  if (!completed.length && !elements.size) throw new Error(`Discovery provider could not complete this search. ${warnings.join(' ')}`);
  return result;
}
