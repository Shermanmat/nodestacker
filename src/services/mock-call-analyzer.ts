/**
 * Mock VC call analyzer. Takes a transcript of a founder's practice pitch call
 * and runs it through Claude playing an experienced investor + coach. Produces a
 * structured readout — overall score, a per-dimension scorecard, the founder's
 * blind spots, and the top coaching fixes before the real raise — and stores it
 * on the mock_call_analyses table.
 *
 * This is prep, in MatCap's point-guard voice: we sharpen the pitch and steer the
 * founder around mistakes. The founder still owns the raise — we don't run it for
 * them, and this never scripts their answers.
 */

import { eq } from 'drizzle-orm';
import { db, founders, publicCompanies, publicUsers, mockCallAnalyses, founderLeads } from '../db/index.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
// Opus 4.8 for the analysis — blind-spot detection and coaching are the
// quality-critical piece and benefit from the strongest model. Swap to
// 'claude-sonnet-4-6' (the house default for generation) to cut cost.
const MODEL = 'claude-opus-4-8';

export interface ScorecardLine {
  dimension: string;      // Clarity, Market, Traction, Team, The ask, Objection handling,
                          // Leading the room, Reverse diligence, Closing & next steps
  score: number;          // 1–5
  note: string;           // one-line rationale
}

export interface BlindSpot {
  moment: string;         // what the founder said / the moment in the call
  issue: string;          // the blind spot itself
  whyItMatters: string;   // how a real investor reads it
}

export interface CoachingNote {
  fix: string;            // the thing to fix
  how: string;            // concrete how, in Mat's plain point-guard voice
}

export interface MockCallAnalysisResult {
  overallScore: number;   // 1–10 headline
  summary: string;        // 2–3 sentence readout
  scorecard: ScorecardLine[];
  blindSpots: BlindSpot[];
  coaching: CoachingNote[];
}

const SYSTEM_PROMPT = `You are a seasoned early-stage investor AND a founder coach, running a debrief for MatCap.
A founder just did a MOCK pitch call (practice, not a real investor). You're given the transcript plus what we know about their company. Your job is to find their blind spots and help them win the REAL raise.

MatCap's role — read this carefully. MatCap is the founder's fundraise point guard, not the quarterback. The founder owns the pitch and the raise; MatCap opens doors, sharpens the pitch, and steers them around mistakes. So your coaching SHARPENS what the founder already has — it never scripts their answers or takes over the raise. Speak in Mat's plain, direct, candid voice. No corporate hedging, no flattery.

What to look for:
- Where they hedged, dodged, rambled, or clearly didn't know their own numbers.
- Claims an investor would poke immediately (TAM hand-waving, no moat, unclear use of funds, weak "why now", team gaps, the cofounder question).
- The moment the pitch lost energy or clarity.
- Questions they fumbled or answered defensively.
- WHO DROVE THE CALL. Did the founder set the tone and lead the conversation, or did they let the investor steer the entire thing and just answer questions? The strongest founders run the room — they guide the arc and control the pace, they don't just react. A founder who only ever answers reads as junior or passive.
- REVERSE DILIGENCE. Did the founder carve out time to ask sharp questions about the FIRM — check size, thesis fit, how the firm actually helps, relevant portfolio? A pitch is a two-way evaluation. Founders who never turn it around look desperate or naive; the best ones qualify the investor too.
- CLOSING / NEXT STEPS. Did the founder drive toward a concrete next step — ideally saving roughly the last 5 minutes to set up another conversation or push for a decision — rather than letting the call fizzle out? Did they close, or did they leave it to the investor?

Be honest and specific. Quote or paraphrase the actual moment — no generic advice that could apply to any pitch.

Note on partial calls: if the transcript clearly ends mid-call (cut off before the founder could ask questions or set up next steps), SAY SO in the relevant note and don't score "Reverse diligence" or "Closing & next steps" as an outright failure — flag that that phase of the call wasn't reached rather than assuming the founder skipped it.

Return STRICT JSON only — no preamble, no markdown, no commentary before or after. Exactly this shape:
{
  "overallScore": <1-10 integer, how ready this founder is to pitch investors today>,
  "summary": "<2-3 sentences, the blunt TLDR a founder would want>",
  "scorecard": [
    { "dimension": "Clarity", "score": <1-5>, "note": "<one line>" },
    { "dimension": "Market", "score": <1-5>, "note": "<one line>" },
    { "dimension": "Traction", "score": <1-5>, "note": "<one line>" },
    { "dimension": "Team", "score": <1-5>, "note": "<one line>" },
    { "dimension": "The ask", "score": <1-5>, "note": "<one line>" },
    { "dimension": "Objection handling", "score": <1-5>, "note": "<one line>" },
    { "dimension": "Leading the room", "score": <1-5>, "note": "<did the founder set the tone and drive, or get driven by the investor?>" },
    { "dimension": "Reverse diligence", "score": <1-5>, "note": "<did they ask sharp questions about the firm / fit? or note if the call was cut off before this>" },
    { "dimension": "Closing & next steps", "score": <1-5>, "note": "<did they drive a next conversation or decision, ideally in the last ~5 min? or note if the call was cut off>" }
  ],
  "blindSpots": [ { "moment": "<what they said / the moment>", "issue": "<the blind spot>", "whyItMatters": "<how an investor reads it>" } ],
  "coaching": [ { "fix": "<the fix>", "how": "<concrete how, Mat's voice>" } ]
}
- Include every blind spot you find (usually 3–6). Cap "coaching" at the 3 highest-leverage fixes before the next call.`;

export interface AnalyzeInput {
  transcript: string;
  founderId?: number;
  publicCompanyId?: number;
  /** Gym persona key the founder practiced against (tags the analysis as a rep). */
  persona?: string;
  /** Source Tavus conversation id (idempotency for gym reps). */
  tavusConversationId?: string;
  /** Optional free-text company context if there's no DB record to pull from. */
  contextOverride?: string;
}

/** Assemble the "what we know about this company" block from whatever record we have. */
async function buildContext(input: AnalyzeInput): Promise<{ context: string; founderName: string | null; companyName: string | null }> {
  const lines: string[] = [];
  let founderName: string | null = null;
  let companyName: string | null = null;

  if (input.founderId) {
    const f = await db.query.founders.findFirst({ where: eq(founders.id, input.founderId) });
    if (f) {
      founderName = f.name;
      companyName = f.companyName;
      lines.push(`Founder: ${f.name}`);
      lines.push(`Company: ${f.companyName}`);
      if (f.companyStage) lines.push(`Stage: ${f.companyStage}`);
      if (f.roundStatus) lines.push(`Round status: ${f.roundStatus}`);
      if (f.blurb) lines.push(`Pitch blurb: ${f.blurb}`);
      if (f.city || f.country) lines.push(`Location: ${[f.city, f.country].filter(Boolean).join(', ')}`);
    }
  }

  if (input.publicCompanyId) {
    const c = await db.query.publicCompanies.findFirst({ where: eq(publicCompanies.id, input.publicCompanyId) });
    if (c) {
      companyName = companyName || c.companyName;
      lines.push(`Company: ${c.companyName}`);
      if (c.oneLiner) lines.push(`One-liner: ${c.oneLiner}`);
      if (c.sector) lines.push(`Sector: ${c.sector}`);
      if (c.url) lines.push(`Website: ${c.url}`);
      const u = await db.query.publicUsers.findFirst({ where: eq(publicUsers.id, c.userId) });
      if (u) {
        founderName = founderName || [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
        lines.push(`Founder: ${[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}`);
        if (u.oneLiner) lines.push(`Founder bio: ${u.oneLiner}`);
      }
      const lead = await db.query.founderLeads.findFirst({ where: eq(founderLeads.publicCompanyId, c.id) });
      if (lead?.investorBlurb) lines.push(`Investor blurb they wrote: ${lead.investorBlurb}`);
    }
  }

  if (input.contextOverride) lines.push(input.contextOverride);

  const context = lines.length ? lines.join('\n') : 'No company context on file — judge the pitch on its own terms.';
  return { context, founderName, companyName };
}

/** Coerce whatever the model returned into a safe, well-shaped result. */
function normalize(parsed: any): MockCallAnalysisResult {
  const arr = (v: any) => (Array.isArray(v) ? v : []);
  return {
    overallScore: Math.max(1, Math.min(10, Math.round(Number(parsed?.overallScore) || 0))),
    summary: String(parsed?.summary || '').slice(0, 1000),
    scorecard: arr(parsed?.scorecard).map((s: any) => ({
      dimension: String(s?.dimension || '').slice(0, 60),
      score: Math.max(1, Math.min(5, Math.round(Number(s?.score) || 0))),
      note: String(s?.note || '').slice(0, 300),
    })),
    blindSpots: arr(parsed?.blindSpots).map((b: any) => ({
      moment: String(b?.moment || '').slice(0, 600),
      issue: String(b?.issue || '').slice(0, 600),
      whyItMatters: String(b?.whyItMatters || '').slice(0, 600),
    })),
    coaching: arr(parsed?.coaching).slice(0, 3).map((c: any) => ({
      fix: String(c?.fix || '').slice(0, 400),
      how: String(c?.how || '').slice(0, 800),
    })),
  };
}

/**
 * Analyze a mock call transcript, store the result, and return it (with the row id).
 * Returns null if the API key is missing (advisory feature — don't hard-fail the caller).
 */
export async function analyzeMockCall(
  input: AnalyzeInput,
): Promise<{ id: number; analysis: MockCallAnalysisResult } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[mock-call-analyzer] ANTHROPIC_API_KEY not set — skipping');
    return null;
  }
  const transcript = (input.transcript || '').trim();
  if (!transcript) throw new Error('Transcript is empty');

  const { context, founderName, companyName } = await buildContext(input);
  const userMsg =
    `What we know about this company:\n${context}\n\n` +
    `--- MOCK CALL TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status} - ${await res.text()}`);
  const data = await res.json();
  const raw = data.content?.[0]?.text || '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Analyzer returned non-JSON: ${raw.slice(0, 200)}`);
  const analysis = normalize(JSON.parse(match[0]));

  const [row] = await db.insert(mockCallAnalyses).values({
    founderId: input.founderId ?? null,
    publicCompanyId: input.publicCompanyId ?? null,
    founderName,
    companyName,
    transcript,
    overallScore: analysis.overallScore,
    summary: analysis.summary,
    scorecard: JSON.stringify(analysis.scorecard),
    blindSpots: JSON.stringify(analysis.blindSpots),
    coaching: JSON.stringify(analysis.coaching),
    persona: input.persona ?? null,
    tavusConversationId: input.tavusConversationId ?? null,
    model: MODEL,
    createdAt: new Date().toISOString(),
  }).returning();

  return { id: row.id, analysis };
}
