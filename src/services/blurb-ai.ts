/**
 * AI-powered blurb builder for founder applications
 * Uses Claude API for signal detection and blurb generation
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export interface Signal {
  category: string;
  detected: string;
  followUpQuestion: string;
}

export interface SignalAnswer {
  category: string;
  answer: string;
}

export interface AnalyzeResult {
  signals: Signal[];
  sector: string;
}

export interface BlurbResult {
  blurb: string;
  oneLiner: string;
}

const SIGNAL_CATEGORIES = [
  'team_pedigree',
  'education',
  'traction',
  'novel_technology',
  'unique_idea',
  'customer_logos',
  'programs_accelerators',
  'notable_investors',
  'domain_expertise',
];

const SIGNAL_DETECTION_PROMPT = `You are an expert at evaluating startup pitches. Given a startup description, identify the 3 strongest signal categories that would impress investors.

Available signal categories:
- team_pedigree: Repeat founders, notable exits, impressive career history
- education: Stanford, MIT, PhD, other prestigious credentials
- traction: Revenue, users, growth metrics, MRR, ARR
- novel_technology: Patents, proprietary tech, deep R&D, unique technical approach
- unique_idea: First-mover advantage, contrarian thesis, novel market insight
- customer_logos: Enterprise customers, brand-name clients, signed contracts
- programs_accelerators: YC, Techstars, On Deck, other notable programs
- notable_investors: Angels or funds already committed
- domain_expertise: 10+ years in industry, operator background, deep specialization

For each of the 3 strongest signals you detect:
1. Identify what in the description suggests this signal
2. Write a targeted follow-up question that will help the founder strengthen this signal in their blurb

Also identify the primary sector/industry this startup operates in (e.g. "AI/ML", "Fintech", "Healthcare", "SaaS", "Climate Tech", "Consumer", "Cybersecurity", "Biotech", "Web3/Crypto", "EdTech", "PropTech", "DeepTech", etc.)

Respond with ONLY valid JSON (no markdown):
{
  "sector": "detected sector name",
  "signals": [
    { "category": "category_name", "detected": "what you noticed", "followUpQuestion": "A specific question to strengthen this signal" },
    { "category": "category_name", "detected": "what you noticed", "followUpQuestion": "A specific question to strengthen this signal" },
    { "category": "category_name", "detected": "what you noticed", "followUpQuestion": "A specific question to strengthen this signal" }
  ]
}`;

const BLURB_GENERATION_PROMPT = `Generate a polished investor blurb and one-liner for this startup.

Rules for the blurb:
- 3-5 sentences
- Clear, specific, professional tone
- No hype language ("revolutionary", "disrupting", "game-changing")
- Structure around the 3 signal categories provided
- Include concrete details from the follow-up answers
- Should be forwardable to investors as-is

Rules for the one-liner:
- Single sentence: "[Company] is building [what] for [who]."
- Concise and clear

Respond with ONLY valid JSON (no markdown):
{
  "blurb": "The full blurb text...",
  "oneLiner": "[Company] is building..."
}`;

/**
 * Call Claude API
 */
async function callClaude(
  messages: { role: string; content: string }[],
  systemPrompt: string,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

/**
 * Parse JSON from Claude response (handles markdown code blocks)
 */
function parseJsonResponse(content: string): any {
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]).trim() : content;

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const cleaned = jsonStr
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/[\u0000-\u001F]+/g, ' ');
    return JSON.parse(cleaned);
  }
}

/**
 * Analyze a startup description and return 3 strongest signals
 */
export async function analyzeSignals(
  companyName: string,
  description: string,
): Promise<AnalyzeResult> {
  const messages = [
    {
      role: 'user',
      content: `Company: ${companyName}\n\nDescription:\n${description}`,
    },
  ];

  const response = await callClaude(messages, SIGNAL_DETECTION_PROMPT);
  const parsed = parseJsonResponse(response);

  if (!parsed.signals || !Array.isArray(parsed.signals) || parsed.signals.length < 3) {
    throw new Error('Failed to detect 3 signals from the description');
  }

  return {
    signals: parsed.signals.slice(0, 3),
    sector: parsed.sector || 'Technology',
  };
}

/**
 * Generate a polished blurb from the description + signal answers
 */
export async function generateBlurb(
  companyName: string,
  description: string,
  signals: SignalAnswer[],
): Promise<BlurbResult> {
  const signalDetails = signals
    .map((s, i) => `Signal ${i + 1} (${s.category}): ${s.answer}`)
    .join('\n');

  const messages = [
    {
      role: 'user',
      content: `Company: ${companyName}\n\nOriginal Description:\n${description}\n\nFollow-up Answers:\n${signalDetails}`,
    },
  ];

  const response = await callClaude(messages, BLURB_GENERATION_PROMPT);
  const parsed = parseJsonResponse(response);

  if (!parsed.blurb || !parsed.oneLiner) {
    throw new Error('Failed to generate blurb');
  }

  return {
    blurb: parsed.blurb,
    oneLiner: parsed.oneLiner,
  };
}
