// Investor-discovery agent. Uses Claude's server-side web_search tool to find
// ACTIVE pre-seed/seed first-check investors on the open web, extract structured
// records, dedup against the existing network, and queue them for admin review.
//
// $0-subscription tier: no Crunchbase/Apollo — just Claude web search (small
// per-search + token cost on the existing Anthropic bill). Profiles only, no
// contact info. Everything lands in investor_candidates as 'pending' — nothing
// is added to the live investors table until an admin approves it.

import { eq } from 'drizzle-orm';
import { db, investors, investorCandidates } from '../db/index.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

export interface DiscoveredInvestor {
  name: string;
  firm: string | null;
  role: string | null;
  stage: string | null;
  checkSize: string | null;
  thesis: string | null;
  geo: string | null;
  links: string[];
  sourceUrl: string | null;
  confidence: number;
}

const SYSTEM = `You are an investor-sourcing researcher for MatCap, a fundraising network for early-stage founders. Your job: find ACTIVE pre-seed / seed investors who write FIRST checks — solo/angel investors and pre-seed/seed funds comfortable being first money in (leading or co-leading the first round). Any geography.

Use web search across firm sites + their team/portfolio pages, OpenVC, AngelList/Wellfound, investor lists/round-ups, podcasts, and public bios.

ONLY include an investor if they appear to:
- invest at pre-seed or seed, AND
- write first checks / be first money in, AND
- be actively investing now (recent activity, open for intros).

Exclude later-stage-only funds, accelerators-as-such, and anyone clearly inactive. Do NOT invent people — only include investors you actually found a real source for.

When done researching, return STRICT JSON and nothing after it:
{ "investors": [ { "name": "...", "firm": "... or null for solo angels", "role": "...", "stage": "pre-seed | seed | pre-seed/seed", "checkSize": "e.g. $25k–100k or null", "thesis": "one line", "geo": "city/region or 'global'", "links": ["url", ...], "sourceUrl": "where you found them", "confidence": 0.0-1.0 } ] }`;

export async function discoverInvestors(opts: {
  count: number;
  excludeNames: string[]; // "name @ firm" of investors we already have
  angle?: string;
}): Promise<DiscoveredInvestor[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const userPrompt = `Find about ${opts.count} active pre-seed/seed first-check investors${opts.angle ? ' (bias toward: ' + opts.angle + ')' : ''}.

EXCLUDE these — already in our network, don't return them:
${opts.excludeNames.slice(0, 50).join(', ') || '(none yet)'}

Research with web search, then return the JSON.`;

  const messages: any[] = [{ role: 'user', content: userPrompt }];
  let finalText = '';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // The web_search server tool runs an internal loop; stop_reason 'pause_turn'
  // means "resume" — re-send the accumulated messages. Keep rounds + searches
  // low: web search pulls large page content into context, which compounds
  // across rounds and can blow past a tight input-tokens/min rate limit.
  for (let round = 0; round < 4; round++) {
    let data: any;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 3500,
          system: SYSTEM,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          messages,
        }),
      });
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '') || 5 * (attempt + 1);
        await sleep(Math.min(60, retryAfter) * 1000); // respect rate limit, then retry same request
        continue;
      }
      if (!res.ok) throw new Error(`Claude API error: ${res.status} - ${(await res.text()).slice(0, 300)}`);
      data = await res.json();
      break;
    }
    if (!data) throw new Error('Claude API rate-limited (429) after retries — try again shortly or raise your org rate limit');
    messages.push({ role: 'assistant', content: data.content });
    for (const b of data.content || []) if (b.type === 'text') finalText += b.text;
    if (data.stop_reason !== 'pause_turn') break;
  }

  const start = finalText.indexOf('{');
  const end = finalText.lastIndexOf('}');
  let parsed: any = {};
  if (start !== -1 && end > start) {
    try { parsed = JSON.parse(finalText.slice(start, end + 1)); } catch { /* leave empty */ }
  }
  const list = Array.isArray(parsed.investors) ? parsed.investors : [];
  const clean = (s: any, n: number) => (s == null ? null : String(s).slice(0, n));
  return list
    .map((x: any): DiscoveredInvestor => ({
      name: String(x?.name || '').slice(0, 160),
      firm: clean(x?.firm, 160),
      role: clean(x?.role, 160),
      stage: clean(x?.stage, 80),
      checkSize: clean(x?.checkSize, 80),
      thesis: clean(x?.thesis, 500),
      geo: clean(x?.geo, 120),
      links: Array.isArray(x?.links) ? x.links.map((l: any) => String(l).slice(0, 300)).slice(0, 6) : [],
      sourceUrl: clean(x?.sourceUrl, 300),
      confidence: Number.isFinite(Number(x?.confidence)) ? Math.min(1, Math.max(0, Number(x.confidence))) : 0.5,
    }))
    .filter((x: DiscoveredInvestor) => x.name.length > 1);
}

// One discovery run: find candidates, dedup against investors + existing
// candidates, and insert the new ones as 'pending'. Returns a small summary.
export async function runInvestorDiscoveryTick(count = 15): Promise<{ found: number; added: number; skipped: number }> {
  if (!process.env.ANTHROPIC_API_KEY) return { found: 0, added: 0, skipped: 0 };

  const key = (name?: string | null, firm?: string | null) =>
    `${(name || '').trim().toLowerCase()}|${(firm || '').trim().toLowerCase()}`;

  const existingInvestors = await db.select({ name: investors.name, firm: investors.firm }).from(investors);
  const existingCandidates = await db.select({ name: investorCandidates.name, firm: investorCandidates.firm }).from(investorCandidates);
  const seen = new Set<string>();
  for (const r of existingInvestors) seen.add(key(r.name, r.firm));
  for (const r of existingCandidates) seen.add(key(r.name, r.firm));

  const excludeNames = existingInvestors
    .map((r) => (r.firm ? `${r.name} @ ${r.firm}` : r.name))
    .slice(0, 50);

  const discovered = await discoverInvestors({ count, excludeNames });

  let added = 0, skipped = 0;
  const now = new Date().toISOString();
  for (const d of discovered) {
    const k = key(d.name, d.firm);
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k);
    await db.insert(investorCandidates).values({
      name: d.name, firm: d.firm, role: d.role, stage: d.stage, checkSize: d.checkSize,
      thesis: d.thesis, geo: d.geo, links: JSON.stringify(d.links), sourceUrl: d.sourceUrl,
      confidence: String(d.confidence), status: 'pending', createdAt: now,
    });
    added++;
  }
  return { found: discovered.length, added, skipped };
}
