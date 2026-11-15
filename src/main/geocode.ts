import { app, net } from 'electron';

export interface GeoResult {
  name: string;
  label: string;
  lat: number;
  lon: number;
  /** 'address' = a street-level match (exact spot); 'place' = a town/city center. */
  kind: 'address' | 'place';
}

/** Lower-case US state name -> postal code, so "Springfield, IL" matches admin1 "Illinois". */
const US_STATES: Record<string, string> = Object.fromEntries(
  'Alabama AL,Alaska AK,Arizona AZ,Arkansas AR,California CA,Colorado CO,Connecticut CT,Delaware DE,Florida FL,Georgia GA,Hawaii HI,Idaho ID,Illinois IL,Indiana IN,Iowa IA,Kansas KS,Kentucky KY,Louisiana LA,Maine ME,Maryland MD,Massachusetts MA,Michigan MI,Minnesota MN,Mississippi MS,Missouri MO,Montana MT,Nebraska NE,Nevada NV,New Hampshire NH,New Jersey NJ,New Mexico NM,New York NY,North Carolina NC,North Dakota ND,Ohio OH,Oklahoma OK,Oregon OR,Pennsylvania PA,Rhode Island RI,South Carolina SC,South Dakota SD,Tennessee TN,Texas TX,Utah UT,Vermont VT,Virginia VA,Washington WA,West Virginia WV,Wisconsin WI,Wyoming WY,District of Columbia DC,Puerto Rico PR'
    .split(',')
    .map((s) => {
      const i = s.lastIndexOf(' ');
      return [s.slice(0, i).toLowerCase(), s.slice(i + 1)];
    }),
);

const ua = () => `weatherwise-linux/${app.getVersion()} (+https://github.com/patrick-hudson/weatherwise-linux)`;

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  try {
    const r = await net.fetch(url, { headers: { 'User-Agent': ua(), Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** US street addresses via the US Census Bureau geocoder (free, no key). */
async function censusAddress(q: string): Promise<GeoResult[]> {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(q)}`;
  const j = await getJson<{ result?: { addressMatches?: Array<{ matchedAddress: string; coordinates: { x: number; y: number } }> } }>(url, 15_000);
  return (j?.result?.addressMatches ?? []).slice(0, 5).map((m) => ({
    name: 'Home',
    label: titleCase(m.matchedAddress),
    lat: m.coordinates.y,
    lon: m.coordinates.x,
    kind: 'address',
  }));
}

/** Any address or place via OpenStreetMap Nominatim (used sparingly, one request per search). */
async function nominatim(q: string): Promise<GeoResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=0&q=${encodeURIComponent(q)}`;
  const j = await getJson<Array<{ lat: string; lon: string; display_name: string; name?: string; category?: string; addresstype?: string }>>(url);
  return (j ?? []).map((x) => {
    const isAddress = ['house', 'building', 'place', 'road'].includes(x.addresstype ?? '') || /^\d/.test(x.display_name);
    return {
      name: isAddress ? 'Home' : x.name || x.display_name.split(',')[0],
      label: x.display_name.split(',').slice(0, 4).join(',').trim(),
      lat: Number(x.lat),
      lon: Number(x.lon),
      kind: isAddress ? 'address' : 'place',
    } satisfies GeoResult;
  });
}

/** Towns and cities via Open-Meteo's geocoder. "Springfield, IL" filters by state. */
async function openMeteoPlace(q: string): Promise<GeoResult[]> {
  const [name, hint] = q.split(',').map((x) => x.trim());
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=${encodeURIComponent(name)}`;
  const j = await getJson<{ results?: Array<{ name: string; latitude: number; longitude: number; admin1?: string; country_code?: string; country?: string }> }>(url);
  let res = j?.results ?? [];
  if (hint) {
    const h = hint.toLowerCase();
    const filtered = res.filter((x) => [x.admin1, US_STATES[(x.admin1 ?? '').toLowerCase()], x.country, x.country_code].some((v) => v && v.toLowerCase() === h));
    if (filtered.length) res = filtered;
  }
  return res.slice(0, 6).map((x) => ({
    name: x.name,
    label: [x.name, x.admin1, x.country_code].filter(Boolean).join(', '),
    lat: x.latitude,
    lon: x.longitude,
    kind: 'place',
  }));
}

/**
 * Search an address ("123 Main St, Springfield, IL 62701") or a town ("Springfield, IL").
 * Only the typed text is sent, and only when the user searches.
 */
export async function searchLocation(raw: string): Promise<GeoResult[]> {
  const q = String(raw ?? '').trim().slice(0, 200);
  if (!q) return [];
  const looksLikeAddress = /^\s*\d+\s+\S/.test(q);
  if (looksLikeAddress) {
    const census = await censusAddress(q);
    if (census.length) return census;
    return nominatim(q);
  }
  const places = await openMeteoPlace(q);
  return places.length ? places : nominatim(q);
}

function titleCase(s: string): string {
  // Census returns "123 MAIN ST, SPRINGFIELD, IL, 62701"; keep state codes upper-case.
  return s
    .split(', ')
    .map((part) => (/^[A-Z]{2}$/.test(part) || /^\d{5}/.test(part) ? part : part.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())))
    .join(', ');
}
