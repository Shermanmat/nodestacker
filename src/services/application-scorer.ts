/**
 * Shadow application scorer. Rates an inbound founder application 1–10 with a
 * recommendation (let_in / meeting / pass) and a one-line reason.
 *
 * It is ADVISORY ONLY — it never changes a decision. It learns the admin's taste
 * the "lite" way: no fine-tuning, just an LLM + a short rubric + a handful of the
 * admin's REAL past decisions (approved vs declined, with their own reasons when
 * present) as few-shot examples. The score is stored on the application and
 * logged to the agent_actions ledger so agreement with the admin can be tracked
 * over time.
 */

import { eq, inArray, desc } from 'drizzle-orm';
import { db, publicCompanies, publicUsers, founderLeads } from '../db/index.js';
import { recordAction } from './agent-actions.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// applicationStatus values that mean "the admin engaged positively" vs "passed".
const LET_IN = ['approved', 'trial_sent', 'meeting_requested', 'interview_sent'];
const PASSED = ['declined'];

export interface ApplicationScore {
  score: number;                 // 1–10
  recommendation: 'let_in' | 'meeting' | 'pass';
  reasoning: string;
}

const RUBRIC = `You are MatCap's application screener. MatCap gives founders warm intros to investors,
so the bar is: is this a credible, fundable founder we'd be proud to put in front of our investor network?

Weigh: founder quality/background, company clarity + how fundable it looks, traction signals,
market, and stage fit (we work with pre-seed/seed). Penalize: vague/empty descriptions, non-startups,
obvious spam, or clearly out-of-scope.

You will be shown examples of REAL past decisions by the admin (Mat) — learn his taste from them,
not a generic VC rubric. When his reasons are given, weight them heavily.

Return STRICT JSON only:
{ "score": <1-10 integer>, "recommendation": "let_in" | "meeting" | "pass", "reasoning": "<one short sentence in Mat's plain voice>" }
- score 8-10 = strong let_in, 5-7 = worth a meeting / on the fence, 1-4 = pass.
- recommendation: "let_in" (clear yes), "meeting" (talk first), "pass" (no).`;

function appToText(c: any, u: any, blurb?: string | null): string {
  return [
    `Company: ${c.companyName || '—'}`,
    `One-liner: ${c.oneLiner || '—'}`,
    `Sector: ${c.sector || '—'}`,
    c.url ? `Website: ${c.url}` : '',
    `Founder: ${[u?.firstName, u?.lastName].filter(Boolean).join(' ') || '—'}`,
    u?.oneLiner ? `Founder bio: ${u.oneLiner}` : '',
    u?.city ? `City: ${u.city}` : '',
    u?.linkedinUrl ? `LinkedIn: ${u.linkedinUrl}` : '',
    blurb ? `Investor blurb they wrote: ${blurb}` : '',
  ].filter(Boolean).join('\n');
}

/** Build the few-shot block from the admin's real past decisions (balanced). */
async function buildExamples(excludeCompanyId: number): Promise<string> {
  const decided = await db.select().from(publicCompanies)
    .where(inArray(publicCompanies.applicationStatus, [...LET_IN, ...PASSED]))
    .orderBy(desc(publicCompanies.appliedAt))
    .limit(60);

  const lets = decided.filter(c => LET_IN.includes(c.applicationStatus || '') && c.id !== excludeCompanyId).slice(0, 10);
  const passes = decided.filter(c => PASSED.includes(c.applicationStatus || '') && c.id !== excludeCompanyId).slice(0, 10);
  const picks = [...lets, ...passes];
  if (picks.length === 0) return '';

  const userIds = picks.map(c => c.userId);
  const users = userIds.length ? await db.select().from(publicUsers).where(inArray(publicUsers.id, userIds)) : [];
  const userById = new Map(users.map(u => [u.id, u]));

  const blocks = picks.map(c => {
    const decision = LET_IN.includes(c.applicationStatus || '') ? 'LET IN' : 'PASSED';
    const reason = c.decisionReason ? ` (Mat's reason: ${c.decisionReason})` : '';
    return `--- ${decision}${reason} ---\n${appToText(c, userById.get(c.userId))}`;
  });
  return `Here are ${blocks.length} of Mat's real past decisions:\n\n${blocks.join('\n\n')}`;
}

/** Score one application, store the result, and log to the ledger. */
export async function scoreApplication(companyId: number): Promise<ApplicationScore | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[app-scorer] ANTHROPIC_API_KEY not set — skipping');
    return null;
  }
  const company = await db.query.publicCompanies.findFirst({ where: eq(publicCompanies.id, companyId) });
  if (!company) return null;
  const user = await db.query.publicUsers.findFirst({ where: eq(publicUsers.id, company.userId) });
  const lead = await db.query.founderLeads.findFirst({ where: eq(founderLeads.publicCompanyId, companyId) });

  const examples = await buildExamples(companyId);
  const userMsg =
    (examples ? examples + '\n\n' : '') +
    `Now score this NEW application:\n\n${appToText(company, user, lead?.investorBlurb)}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system: RUBRIC, messages: [{ role: 'user', content: userMsg }] }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status} - ${await res.text()}`);
  const data = await res.json();
  const raw = data.content?.[0]?.text || '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Scorer returned non-JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);

  const score: ApplicationScore = {
    score: Math.max(1, Math.min(10, Math.round(Number(parsed.score) || 0))),
    recommendation: ['let_in', 'meeting', 'pass'].includes(parsed.recommendation) ? parsed.recommendation : 'meeting',
    reasoning: String(parsed.reasoning || '').slice(0, 300),
  };

  const now = new Date().toISOString();
  await db.update(publicCompanies).set({
    aiScore: score.score,
    aiRecommendation: score.recommendation,
    aiReasoning: score.reasoning,
    aiScoredAt: now,
  }).where(eq(publicCompanies.id, companyId));

  // Log to the ledger (shadow/advisory — recorded, not awaiting approval).
  try {
    await recordAction({
      agent: 'application-scorer',
      actionType: 'score_application',
      summary: `Scored application: ${company.companyName} → ${score.recommendation} (${score.score}/10)`,
      reasoning: score.reasoning,
      entityType: 'public_company',
      entityId: companyId,
      payload: { ...score, examplesUsed: examples ? true : false },
      status: 'logged',
    });
  } catch (e) {
    console.error('[app-scorer] ledger log failed:', e);
  }

  return score;
}
