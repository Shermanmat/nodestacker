// Small wrapper around Anthropic's Messages API for the reply classifier.
// Takes a raw reply body + minimal context, returns a structured class.
//
// Uses Claude Haiku — the task is structured + short, no need for a bigger
// model. Cost per classification is ~$0.001 so volume isn't a concern.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

export type ReplyClass =
  | 'yes'
  | 'no'
  | 'not_now'
  | 'needs_human'
  | 'out_of_office'
  | 'wrong_person';

export interface ClassifyResult {
  classification: ReplyClass;
  confidence: number; // 0-1
  reason: string;     // short — matches admin's voice ("wrong stage", "not a fit"). Used as passReason on no/not_now.
  suggestedFollowupDate?: string; // ISO date, only when not_now mentions a window
}

const SYSTEM = `You classify the reply an investor sent in response to a warm intro request from MatCap (a fundraising network for founders).

Categories:
- "yes"            → investor wants the meeting / is interested
- "no"             → investor declines, not a fit
- "not_now"        → investor wants to circle back later (raising fund, busy season, between funds, focused elsewhere). Functionally also a pass, but the reason matters.
- "needs_human"    → reply has specific questions, is conditional, or otherwise nuanced and needs a real human response — don't try to handle automatically.
- "out_of_office"  → auto-reply / OOO message / not a real response
- "wrong_person"   → investor says they left the firm / wrong contact / forwards to colleague / not the right person

Guidance on "reason":
- 1-5 words, lowercase, no period.
- Write in the same voice an admin uses in a spreadsheet: "wrong stage", "not a fit", "ghosted", "passed once already", "raising fund", "left firm".
- Empty string only when category is "yes" or "out_of_office".

Confidence calibration:
- 0.9+ for clearly-worded yes/no
- 0.7-0.9 for clear but slightly hedged
- below 0.7 → return "needs_human" instead — better to escalate than misclassify.

Always return strict JSON, nothing else. Schema:
{ "classification": "<category>", "confidence": <0-1>, "reason": "<short>", "suggestedFollowupDate": "<ISO date or omitted>" }`;

export async function classifyReply(replyBody: string, context: {
  founderName: string;
  companyName: string;
  investorName: string;
  investorFirm: string | null;
}): Promise<ClassifyResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const userPrompt = `Context:
- Founder: ${context.founderName} (${context.companyName})
- Investor: ${context.investorName}${context.investorFirm ? ' @ ' + context.investorFirm : ''}

Investor's reply text:
"""
${replyBody.trim().slice(0, 4000)}
"""

Classify and return the JSON.`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
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

  // Strip ```json fences if model wraps the output.
  const cleaned = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const allowed: ReplyClass[] = ['yes', 'no', 'not_now', 'needs_human', 'out_of_office', 'wrong_person'];
  if (!allowed.includes(parsed.classification)) {
    throw new Error(`Bad classification "${parsed.classification}" in: ${raw.slice(0, 200)}`);
  }
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Bad confidence "${parsed.confidence}"`);
  }

  // Confidence floor — anything below 0.7 routes to needs_human.
  const finalClass: ReplyClass = confidence < 0.7 && parsed.classification !== 'needs_human'
    ? 'needs_human'
    : parsed.classification;

  return {
    classification: finalClass,
    confidence,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : '',
    suggestedFollowupDate: typeof parsed.suggestedFollowupDate === 'string'
      ? parsed.suggestedFollowupDate
      : undefined,
  };
}
