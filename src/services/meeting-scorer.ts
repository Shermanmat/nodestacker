// Match + score a founder's VC meeting transcript (e.g. from Granola).
//
// One LLM call does both jobs: (1) decide which of the founder's pipeline
// investors this meeting is with — picking from a candidate list we pass in —
// and (2) extract objective signals + score the meeting. The matching is scoped
// to ONE founder's pipeline, so the candidate set is small and the model only
// has to disambiguate, not search the world.
//
// Mirrors reply-llm.ts: raw fetch to Anthropic, strict-JSON out, Haiku.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

export interface MeetingCandidate {
  pipelineId: string;       // composite "<kind>:<id>" — what we attach to
  name: string | null;
  firm: string | null;
}

export interface MeetingScore {
  isInvestorMeeting: boolean;
  matchedPipelineId: string | null;   // one of the candidate ids, or null
  matchedInvestorName: string | null;
  matchConfidence: number;             // 0-1
  meetingType: 'first_meeting' | 'follow_up' | 'partner' | 'diligence' | 'unknown';
  outcome: 'advancing' | 'soft_pass' | 'hard_pass' | 'wants_follow_up' | 'unclear';
  summary: string;                     // 1-2 sentences
  nextStep: { text: string | null; date: string | null };
  investorAsks: string[];
  scores: {
    comms_quality: { value: number; why: string };       // 1-5
    investor_sentiment: { value: number; why: string };   // 1-5
    follow_through: { value: number; why: string };       // 1-5
  };
  evidence: Array<{ claim: string; quote: string }>;
}

const SYSTEM = `You analyze a transcript of a startup founder's meeting with a potential investor. The founder is raising money; you help their fundraising platform (MatCap) track and coach the raise.

You do TWO things and return ONE JSON object.

1) MATCH — decide which investor from the provided candidate list this meeting is with.
   - Match on names (incl. first-name-only), firm names, and context in the transcript/title.
   - Return the candidate's pipelineId, or null if none clearly match.
   - Default isInvestorMeeting to TRUE whenever a founder is pitching their company to someone evaluating it for investment — even if it ends in a pass. Only set it false for a clearly different context (a customer/sales call, internal team sync, personal chat).

2) SCORE — extract objective signals and rate the meeting.
   - meetingType: first_meeting | follow_up | partner | diligence | unknown
   - outcome: advancing | soft_pass | hard_pass | wants_follow_up | unclear
   - nextStep: the concrete agreed next action + ISO date if one was stated (else nulls)
   - investorAsks: specific things the investor requested (data room, refs, metrics…)
   - scores (1-5 each, with a short "why"):
       comms_quality      → how clearly/effectively the FOUNDER communicated
       investor_sentiment → how genuinely interested the INVESTOR was
       follow_through     → were next steps clear, owned, and time-bound
   - evidence: 1-3 short verbatim quotes that justify your read

CRITICAL on investor_sentiment: VCs speak in soft passes. "This is exciting, let's stay in touch", "send it to the team", "loop back after more traction" are usually POLITE NO's, not real interest. Score sentiment on what they'll actually DO (concrete next meeting, intro, term discussion), not on enthusiasm words. Reserve 4-5 for clear, concrete forward motion.

matchConfidence calibration: 0.9+ only when the investor is unambiguous; 0.7-0.9 when likely; below 0.7 when unsure (we will route those to human review rather than auto-attach).

Return STRICT JSON only, this exact schema:
{
  "isInvestorMeeting": <bool>,
  "matchedPipelineId": "<id or null>",
  "matchedInvestorName": "<name or null>",
  "matchConfidence": <0-1>,
  "meetingType": "<...>",
  "outcome": "<...>",
  "summary": "<1-2 sentences>",
  "nextStep": { "text": "<or null>", "date": "<ISO or null>" },
  "investorAsks": ["..."],
  "scores": {
    "comms_quality": { "value": <1-5>, "why": "<short>" },
    "investor_sentiment": { "value": <1-5>, "why": "<short>" },
    "follow_through": { "value": <1-5>, "why": "<short>" }
  },
  "evidence": [{ "claim": "<short>", "quote": "<verbatim>" }]
}`;

export async function matchAndScoreMeeting(opts: {
  founderName: string;
  companyName: string | null;
  title: string | null;
  transcript: string;
  candidates: MeetingCandidate[];
}): Promise<MeetingScore> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const candidateList = opts.candidates.length
    ? opts.candidates.map((c) => `- ${c.pipelineId}: ${c.name ?? '(no name)'}${c.firm ? ' @ ' + c.firm : ''}`).join('\n')
    : '(no investors in pipeline yet)';

  const userPrompt = `Founder: ${opts.founderName}${opts.companyName ? ' (' + opts.companyName + ')' : ''}

Candidate investors in this founder's pipeline (match against these; return the pipelineId):
${candidateList}

Meeting title: ${opts.title || '(none)'}

Transcript:
"""
${opts.transcript.trim().slice(0, 16000)}
"""

Match and score. Return the JSON.`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1600,
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${text}`);
  }
  const data = await response.json();
  const raw = data.content?.[0]?.text || '';
  const stopReason = data.stop_reason;

  // Robustly extract the JSON object: strip code fences, then take the
  // outermost { ... } so trailing prose or a missing closing fence don't break us.
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);

  let p: any;
  try {
    p = JSON.parse(cleaned);
  } catch {
    const hint = stopReason === 'max_tokens' ? ' (response hit max_tokens — truncated)' : '';
    throw new Error(`Claude returned non-JSON${hint}: ${raw.slice(0, 200)}`);
  }

  const clampScore = (v: any) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
  };
  const conf = Number(p.matchConfidence);

  // Only accept a matched id that's actually in the candidate list.
  const validIds = new Set(opts.candidates.map((c) => c.pipelineId));
  const matchedPipelineId = typeof p.matchedPipelineId === 'string' && validIds.has(p.matchedPipelineId)
    ? p.matchedPipelineId
    : null;

  return {
    isInvestorMeeting: p.isInvestorMeeting !== false,
    matchedPipelineId,
    matchedInvestorName: typeof p.matchedInvestorName === 'string' ? p.matchedInvestorName : null,
    matchConfidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
    meetingType: p.meetingType || 'unknown',
    outcome: p.outcome || 'unclear',
    summary: typeof p.summary === 'string' ? p.summary.slice(0, 1000) : '',
    nextStep: {
      text: p.nextStep?.text ? String(p.nextStep.text).slice(0, 500) : null,
      date: p.nextStep?.date ? String(p.nextStep.date).slice(0, 40) : null,
    },
    investorAsks: Array.isArray(p.investorAsks) ? p.investorAsks.map((a: any) => String(a).slice(0, 200)).slice(0, 10) : [],
    scores: {
      comms_quality: { value: clampScore(p.scores?.comms_quality?.value), why: String(p.scores?.comms_quality?.why || '').slice(0, 300) },
      investor_sentiment: { value: clampScore(p.scores?.investor_sentiment?.value), why: String(p.scores?.investor_sentiment?.why || '').slice(0, 300) },
      follow_through: { value: clampScore(p.scores?.follow_through?.value), why: String(p.scores?.follow_through?.why || '').slice(0, 300) },
    },
    evidence: Array.isArray(p.evidence)
      ? p.evidence.slice(0, 5).map((e: any) => ({ claim: String(e?.claim || '').slice(0, 200), quote: String(e?.quote || '').slice(0, 500) }))
      : [],
  };
}
