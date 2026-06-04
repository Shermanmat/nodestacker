// US state list + city→state inference. Used by:
//   - admin form (state dropdown when editing an investor)
//   - investor migration (one-time backfill of `state` from `city` for rows
//     where a known city maps to a state)
//   - filter UI (the set of states present in the DB)

export const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'AL', name: 'Alabama' },     { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },     { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },     { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },      { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },    { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },        { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },    { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },       { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },   { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },    { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },    { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' }, { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },        { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },      { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' }, { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' }, { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },       { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },     { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },   { code: 'WY', name: 'Wyoming' },
];

// City names (lowercased, trimmed) → state code. Covers the major startup
// metros plus common variations. Anything not in here returns null from
// inferState — admin can fill state manually for those.
const CITY_TO_STATE: Record<string, string> = {
  // SF Bay
  'san francisco': 'CA', sf: 'CA', 'san mateo': 'CA', 'palo alto': 'CA',
  'mountain view': 'CA', 'menlo park': 'CA', 'redwood city': 'CA',
  'santa clara': 'CA', 'san jose': 'CA', sunnyvale: 'CA', cupertino: 'CA',
  oakland: 'CA', berkeley: 'CA', fremont: 'CA', 'south san francisco': 'CA',
  // LA / SoCal
  'los angeles': 'CA', la: 'CA', hollywood: 'CA', 'santa monica': 'CA',
  'venice': 'CA', 'pasadena': 'CA', 'long beach': 'CA', irvine: 'CA',
  'san diego': 'CA', sandiego: 'CA',
  // Phoenix metro
  phoenix: 'AZ', phx: 'AZ', scottsdale: 'AZ', tempe: 'AZ', mesa: 'AZ',
  chandler: 'AZ', gilbert: 'AZ', glendale: 'AZ', tucson: 'AZ',
  // NYC metro
  'new york': 'NY', 'new york city': 'NY', nyc: 'NY', manhattan: 'NY',
  brooklyn: 'NY', queens: 'NY', bronx: 'NY',
  // Boston area
  boston: 'MA', cambridge: 'MA', somerville: 'MA',
  // Texas
  austin: 'TX', 'austin tx': 'TX', dallas: 'TX', houston: 'TX',
  'san antonio': 'TX', 'fort worth': 'TX', plano: 'TX',
  // PNW
  seattle: 'WA', bellevue: 'WA', kirkland: 'WA', redmond: 'WA',
  portland: 'OR',
  // Colorado
  denver: 'CO', boulder: 'CO', 'colorado springs': 'CO',
  // Other tech hubs
  miami: 'FL', orlando: 'FL', tampa: 'FL', 'fort lauderdale': 'FL',
  chicago: 'IL',
  atlanta: 'GA',
  nashville: 'TN', knoxville: 'TN', memphis: 'TN',
  raleigh: 'NC', durham: 'NC', charlotte: 'NC',
  'salt lake city': 'UT', slc: 'UT', provo: 'UT',
  'las vegas': 'NV',
  'minneapolis': 'MN', 'saint paul': 'MN', 'st paul': 'MN',
  pittsburgh: 'PA', philadelphia: 'PA', philly: 'PA',
  detroit: 'MI', 'ann arbor': 'MI',
  // DC area
  'washington': 'DC', 'washington dc': 'DC', 'washington d.c.': 'DC',
  'arlington': 'VA', alexandria: 'VA', reston: 'VA',
  bethesda: 'MD', baltimore: 'MD',
  // NJ
  jersey: 'NJ', 'jersey city': 'NJ', hoboken: 'NJ', newark: 'NJ',
  // New England misc
  providence: 'RI',
  'new haven': 'CT', stamford: 'CT', greenwich: 'CT',
  // Other
  honolulu: 'HI',
  'kansas city': 'MO',
  indianapolis: 'IN',
  cleveland: 'OH', columbus: 'OH', cincinnati: 'OH',
  louisville: 'KY',
};

export function inferState(city: string | null | undefined): string | null {
  if (!city) return null;
  const key = String(city).trim().toLowerCase();
  return CITY_TO_STATE[key] ?? null;
}

export const STATE_CODES: ReadonlySet<string> = new Set(US_STATES.map(s => s.code));
