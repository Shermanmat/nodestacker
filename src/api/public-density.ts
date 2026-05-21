import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, founders, publicUsers } from '../db/index.js';

const app = new Hono();

// Canonical metro mapping: lowercased raw-city tokens → metro key.
// Add aliases here when new spelling variants land in the DB.
const METROS: Record<string, { key: string; label: string; lat: number; lng: number; active?: boolean }> = {
  phoenix:     { key: 'PHOENIX', label: 'PHOENIX', lat: 33.4484, lng: -112.0740, active: true },
  scottsdale:  { key: 'PHOENIX', label: 'PHOENIX', lat: 33.4484, lng: -112.0740, active: true },
  tempe:       { key: 'PHOENIX', label: 'PHOENIX', lat: 33.4484, lng: -112.0740, active: true },
  mesa:        { key: 'PHOENIX', label: 'PHOENIX', lat: 33.4484, lng: -112.0740, active: true },
  chandler:    { key: 'PHOENIX', label: 'PHOENIX', lat: 33.4484, lng: -112.0740, active: true },
  gilbert:     { key: 'PHOENIX', label: 'PHOENIX', lat: 33.4484, lng: -112.0740, active: true },
  phx:         { key: 'PHOENIX', label: 'PHOENIX', lat: 33.4484, lng: -112.0740, active: true },

  'san francisco': { key: 'SF_BAY', label: 'SF BAY', lat: 37.7749, lng: -122.4194 },
  sf:              { key: 'SF_BAY', label: 'SF BAY', lat: 37.7749, lng: -122.4194 },
  'san mateo':     { key: 'SF_BAY', label: 'SF BAY', lat: 37.7749, lng: -122.4194 },
  oakland:         { key: 'SF_BAY', label: 'SF BAY', lat: 37.7749, lng: -122.4194 },
  berkeley:        { key: 'SF_BAY', label: 'SF BAY', lat: 37.7749, lng: -122.4194 },
  'palo alto':     { key: 'SF_BAY', label: 'SF BAY', lat: 37.7749, lng: -122.4194 },
  'mountain view': { key: 'SF_BAY', label: 'SF BAY', lat: 37.7749, lng: -122.4194 },
  'santa clara':   { key: 'SF_BAY', label: 'SF BAY', lat: 37.7749, lng: -122.4194 },

  'los angeles': { key: 'LA', label: 'LOS ANGELES', lat: 34.0522, lng: -118.2437 },
  la:            { key: 'LA', label: 'LOS ANGELES', lat: 34.0522, lng: -118.2437 },
  hollywood:     { key: 'LA', label: 'LOS ANGELES', lat: 34.0522, lng: -118.2437 },
  'santa monica':{ key: 'LA', label: 'LOS ANGELES', lat: 34.0522, lng: -118.2437 },

  'new york':       { key: 'NYC', label: 'NYC', lat: 40.7128, lng: -74.0060 },
  'new york city':  { key: 'NYC', label: 'NYC', lat: 40.7128, lng: -74.0060 },
  nyc:              { key: 'NYC', label: 'NYC', lat: 40.7128, lng: -74.0060 },
  manhattan:        { key: 'NYC', label: 'NYC', lat: 40.7128, lng: -74.0060 },
  brooklyn:         { key: 'NYC', label: 'NYC', lat: 40.7128, lng: -74.0060 },

  washington:      { key: 'DC', label: 'WASHINGTON DC', lat: 38.9072, lng: -77.0369 },
  'washington dc': { key: 'DC', label: 'WASHINGTON DC', lat: 38.9072, lng: -77.0369 },
  dc:              { key: 'DC', label: 'WASHINGTON DC', lat: 38.9072, lng: -77.0369 },

  miami:        { key: 'MIAMI', label: 'MIAMI', lat: 25.7617, lng: -80.1918 },

  'las vegas':  { key: 'LAS_VEGAS', label: 'LAS VEGAS', lat: 36.1699, lng: -115.1398 },
  vegas:        { key: 'LAS_VEGAS', label: 'LAS VEGAS', lat: 36.1699, lng: -115.1398 },

  austin:       { key: 'AUSTIN', label: 'AUSTIN', lat: 30.2672, lng: -97.7431 },
  denver:       { key: 'DENVER', label: 'DENVER', lat: 39.7392, lng: -104.9903 },
  seattle:      { key: 'SEATTLE', label: 'SEATTLE', lat: 47.6062, lng: -122.3321 },
  chicago:      { key: 'CHICAGO', label: 'CHICAGO', lat: 41.8781, lng: -87.6298 },
  boston:       { key: 'BOSTON', label: 'BOSTON', lat: 42.3601, lng: -71.0589 },
  atlanta:      { key: 'ATLANTA', label: 'ATLANTA', lat: 33.7490, lng: -84.3880 },
  nashville:    { key: 'NASHVILLE', label: 'NASHVILLE', lat: 36.1627, lng: -86.7816 },
  portland:     { key: 'PORTLAND', label: 'PORTLAND', lat: 45.5152, lng: -122.6784 },
  'salt lake city': { key: 'SLC', label: 'SALT LAKE CITY', lat: 40.7608, lng: -111.8910 },
  detroit:      { key: 'DETROIT', label: 'DETROIT', lat: 42.3314, lng: -83.0458 },
};

// Strip state suffixes / commas / whitespace, lowercase.
// "Phoenix, AZ" → "phoenix", "PHX" → "phx", "San Francisco/Toronto" → "san francisco"
function normalizeCity(raw: string): string {
  if (!raw) return '';
  let s = raw.toLowerCase().trim();
  // Take part before first comma or slash
  s = s.split(',')[0].split('/')[0].trim();
  // Strip trailing periods
  s = s.replace(/[.]+$/, '').trim();
  return s;
}

app.get('/', async (c) => {
  // Pull cities from both founders and public_users
  const founderCities = await db
    .select({ city: founders.city })
    .from(founders)
    .where(sql`${founders.city} IS NOT NULL AND TRIM(${founders.city}) != ''`);

  const userCities = await db
    .select({ city: publicUsers.city })
    .from(publicUsers)
    .where(sql`${publicUsers.city} IS NOT NULL AND TRIM(${publicUsers.city}) != ''`);

  const allCities = [...founderCities, ...userCities].map(r => r.city || '');

  // Aggregate by metro
  const metroCount = new Map<string, { label: string; lat: number; lng: number; active?: boolean; count: number }>();
  let mapped = 0;
  let unmapped = 0;
  const unmappedSet = new Set<string>();

  for (const raw of allCities) {
    const norm = normalizeCity(raw);
    if (!norm) continue;
    const metro = METROS[norm];
    if (!metro) {
      unmapped++;
      unmappedSet.add(norm);
      continue;
    }
    mapped++;
    const existing = metroCount.get(metro.key);
    if (existing) {
      existing.count += 1;
    } else {
      metroCount.set(metro.key, {
        label: metro.label,
        lat: metro.lat,
        lng: metro.lng,
        active: metro.active,
        count: 1,
      });
    }
  }

  const cities = Array.from(metroCount.entries())
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count);

  return c.json({
    cities,
    totalMapped: mapped,
    totalUnmapped: unmapped,
    unmappedSample: Array.from(unmappedSet).slice(0, 20),
    updatedAt: new Date().toISOString(),
  });
});

export default app;
