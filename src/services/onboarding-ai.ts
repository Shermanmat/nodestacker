/**
 * AI-powered conversational founder onboarding
 * Uses Claude API for natural conversation and information extraction
 */

import { db, founderLeads } from '../db/index.js';
import { eq } from 'drizzle-orm';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Message types for conversation history
export interface ConversationMessage {
  role: 'assistant' | 'user';
  content: string;
}

// Extracted data structure
export interface ExtractedData {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  companyName: string | null;
  companyDescription: string | null;
  sector: string | null;
  primaryPersona: string | null;
  secondaryPersona: string | null;
  fundraisingExperience: string | null;
  investorNetworkNumber: number | null;
  investorNetworkRange: string | null;
  companyStage: string | null;
  geographyContext: string | null;
}

// Generated outputs
export interface GeneratedOutputs {
  investorBlurb: string;
  oneLiner: string;
}

const SYSTEM_PROMPT = `You are conducting a MatCap founder intake interview. Your goal is to have a natural conversation that extracts specific information about the founder and their company.

CONVERSATION STYLE:
- Thoughtful and intelligent, not robotic
- Ask one question at a time
- Follow up when answers are vague
- Be encouraging but not sycophantic
- Keep responses concise (1-3 sentences)

REQUIRED INFORMATION TO EXTRACT:
1. First Name & Last Name: Get their full name upfront
2. Company Name: Required - ask if not provided
3. Company Description: What they're building, for whom, what problem it solves
4. Sector: Industry category (fintech, healthtech, AI, defense, SaaS, climate, etc.)
5. Background: Founder's experience and career history
6. Stage: Idea → Building → Pilots → Customers → Revenue → Scaling
7. Fundraising Experience: Prior raises or attempts
8. Investor Network: Number of investors they could email today
9. Geography: Tech hub or not
10. Email: Required before generating output

PERSONA IDENTIFICATION:
Based on background, classify as one of:
- high_slope_builder: Fast learner, multiple pivots/exits, adaptable
- experienced_operator: 10+ years, management experience, industry expertise
- business_oriented_coder: Self-taught technical, business background
- large_company_spinout: Left FAANG/major tech to start company
- startup_insider_first_time: Worked at funded startups, now founding
- scrappy_bootstrapped: Side projects, self-funded history
- domain_expert: PhD or deep expertise in specific field

STAGE MAPPING:
- "Just an idea", "haven't built yet" → idea
- "Building MVP", "coding it now" → building_product
- "Testing with companies", "pilots" → design_partners
- "Have paying customers" → early_customers
- "Generating revenue", "$X MRR" → revenue
- "Growing fast", "hiring" → scaling

NETWORK BUCKETS:
Based on the exact number provided:
- 0-5 → "0-5" (cold network)
- 6-15 → "5-15" (limited)
- 16-30 → "15-30" (decent)
- 31-50 → "30-50" (strong)
- 51+ → "50+" (extensive)

GEOGRAPHY:
- major_tech_hub: SF, NYC, Boston, LA, Seattle, Austin
- outside_tech_hubs: Anywhere else

FUNDRAISING EXPERIENCE:
- raised_venture: Previously raised VC personally
- worked_at_venture_backed: Worked at a VC-backed startup
- attempted_raise: Tried raising before but didn't close
- never_attempted: First time fundraising

CONVERSATION FLOW:
1. Start: "Hey! I'm excited to learn about what you're building. First, what's your name and the name of your company?"
2. After name/company: "Nice to meet you, [First Name]. Tell me about [Company Name] — what are you building?"
3. Then naturally flow through: background, stage, fundraising, network, geography
4. For network, ask specifically: "How many investors could you email today who would know what you're building?"
5. Request email before finishing: "Before I generate your blurb, what's the best email to send it to?"

EDGE CASE HANDLING:
- Vague answers: Ask for specifics. "What does the platform actually do? Who uses it?"
- "It's like Uber for X": "Help me understand the core workflow. What does a user actually do?"
- "We're in stealth": "I get it. At a high level, what problem space are you in?"
- Missing info: Follow up specifically. "Who specifically pays for this?"
- Hesitant on email: "I'll use this email just to send your blurb. No spam, promise."

IMPORTANT:
- Do NOT generate the final blurb until ALL required information is collected
- If something is missing, keep asking questions
- Once you have everything including email, simply say something like "Great, give me a moment to put together your blurb." Keep it brief and natural.
- NEVER output structured data, profiles, or internal classifications to the user. All extraction happens behind the scenes.
- Your responses should always be conversational, not formatted data.`;

const OUTPUT_GENERATION_PROMPT = `Based on the conversation, generate:

1. INVESTOR BLURB (3-5 sentences)
Rules:
- Clear and specific
- No hype language ("revolutionary", "disrupting", "game-changing")
- Forwardable to investors
- Include: what the company is, who it's for, traction/proof if available, founder credibility if relevant
- Professional tone

2. ONE-LINER
Single sentence: "[Company] is building [what] for [who]."

Respond in JSON format:
{
  "investorBlurb": "The full blurb text...",
  "oneLiner": "[Company] is building..."
}`;

const EXTRACTION_PROMPT = `Based on the conversation so far, extract all available information. Respond in JSON format with these fields (use null if not yet collected):

{
  "firstName": "string or null",
  "lastName": "string or null",
  "email": "string or null",
  "companyName": "string or null",
  "companyDescription": "string or null - what they're building",
  "sector": "string or null - e.g., fintech, healthtech, AI",
  "primaryPersona": "one of: high_slope_builder, experienced_operator, business_oriented_coder, large_company_spinout, startup_insider_first_time, scrappy_bootstrapped, domain_expert, or null",
  "secondaryPersona": "same options as primary, or null",
  "fundraisingExperience": "one of: raised_venture, worked_at_venture_backed, attempted_raise, never_attempted, or null",
  "investorNetworkNumber": "integer or null - exact count they gave",
  "investorNetworkRange": "one of: 0-5, 5-15, 15-30, 30-50, 50+, or null",
  "companyStage": "one of: idea, building_product, design_partners, early_customers, revenue, scaling, or null",
  "geographyContext": "one of: major_tech_hub, outside_tech_hubs, or null",
  "isComplete": "boolean - true if we have firstName, lastName, email, companyName, companyDescription, companyStage, fundraisingExperience, investorNetworkNumber, and email"
}`;

/**
 * Call Claude API for conversation
 */
async function callClaude(
  messages: { role: string; content: string }[],
  systemPrompt: string
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
      messages: messages,
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
  // Try to extract JSON from markdown code block
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]).trim() : content;

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Try cleaning up common issues
    const cleaned = jsonStr
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/[\u0000-\u001F]+/g, ' ');
    return JSON.parse(cleaned);
  }
}

/**
 * Get the opening message for a new conversation
 */
export function getOpeningMessage(): string {
  return "Hey! I'm excited to learn about what you're building. First, what's your name and the name of your company?";
}

/**
 * Process a user message and generate AI response
 */
export async function processMessage(
  sessionId: number,
  userMessage: string
): Promise<{
  response: string;
  isComplete: boolean;
  outputs?: GeneratedOutputs;
}> {
  // Get current conversation
  const lead = await db.query.founderLeads.findFirst({
    where: eq(founderLeads.id, sessionId),
  });

  if (!lead) {
    throw new Error('Session not found');
  }

  // Parse existing conversation history
  const history: ConversationMessage[] = lead.conversationHistory
    ? JSON.parse(lead.conversationHistory)
    : [];

  // Add opening message if this is the first exchange
  if (history.length === 0) {
    history.push({
      role: 'assistant',
      content: getOpeningMessage(),
    });
  }

  // Add user message
  history.push({
    role: 'user',
    content: userMessage,
  });

  // Format messages for Claude
  const claudeMessages = history.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // Get AI response
  const aiResponse = await callClaude(claudeMessages, SYSTEM_PROMPT);

  // Add AI response to history
  history.push({
    role: 'assistant',
    content: aiResponse,
  });

  // Extract data from conversation
  const extractionMessages = [
    ...claudeMessages,
    { role: 'assistant', content: aiResponse },
    { role: 'user', content: EXTRACTION_PROMPT },
  ];

  const extractionResponse = await callClaude(extractionMessages, 'Extract information from the conversation. Respond only with valid JSON.');
  let extractedData: ExtractedData & { isComplete: boolean };

  try {
    extractedData = parseJsonResponse(extractionResponse);
  } catch (e) {
    console.error('Failed to parse extraction response:', extractionResponse);
    extractedData = {
      firstName: null,
      lastName: null,
      email: null,
      companyName: null,
      companyDescription: null,
      sector: null,
      primaryPersona: null,
      secondaryPersona: null,
      fundraisingExperience: null,
      investorNetworkNumber: null,
      investorNetworkRange: null,
      companyStage: null,
      geographyContext: null,
      isComplete: false,
    };
  }

  // Check if we have all required info
  const isComplete = extractedData.isComplete &&
    extractedData.email !== null &&
    extractedData.firstName !== null &&
    extractedData.companyName !== null;

  let outputs: GeneratedOutputs | undefined;

  if (isComplete) {
    // Generate the investor blurb and one-liner
    const outputMessages = [
      ...claudeMessages,
      { role: 'assistant', content: aiResponse },
      { role: 'user', content: OUTPUT_GENERATION_PROMPT },
    ];

    const outputResponse = await callClaude(outputMessages, 'Generate professional investor-facing content. Respond only with valid JSON.');

    try {
      outputs = parseJsonResponse(outputResponse);
    } catch (e) {
      console.error('Failed to parse output response:', outputResponse);
    }
  }

  // Update database
  const now = new Date().toISOString();
  await db
    .update(founderLeads)
    .set({
      firstName: extractedData.firstName,
      lastName: extractedData.lastName,
      email: extractedData.email,
      companyName: extractedData.companyName,
      companyDescription: extractedData.companyDescription,
      sector: extractedData.sector,
      primaryPersona: extractedData.primaryPersona,
      secondaryPersona: extractedData.secondaryPersona,
      fundraisingExperience: extractedData.fundraisingExperience,
      investorNetworkNumber: extractedData.investorNetworkNumber,
      investorNetworkRange: extractedData.investorNetworkRange,
      companyStage: extractedData.companyStage,
      geographyContext: extractedData.geographyContext,
      conversationHistory: JSON.stringify(history),
      investorBlurb: outputs?.investorBlurb || lead.investorBlurb,
      oneLiner: outputs?.oneLiner || lead.oneLiner,
      status: isComplete ? 'completed' : 'in_progress',
      completedAt: isComplete ? now : null,
    })
    .where(eq(founderLeads.id, sessionId));

  return {
    response: aiResponse,
    isComplete,
    outputs,
  };
}

/**
 * Create a new onboarding session
 */
export async function createSession(): Promise<{
  sessionId: number;
  openingMessage: string;
}> {
  const now = new Date().toISOString();
  const openingMessage = getOpeningMessage();

  const result = await db
    .insert(founderLeads)
    .values({
      status: 'in_progress',
      conversationHistory: JSON.stringify([
        { role: 'assistant', content: openingMessage },
      ]),
      createdAt: now,
    })
    .returning();

  return {
    sessionId: result[0].id,
    openingMessage,
  };
}

/**
 * Get session state
 */
export async function getSession(sessionId: number): Promise<{
  id: number;
  status: string;
  conversationHistory: ConversationMessage[];
  extractedData: Partial<ExtractedData>;
  outputs?: {
    investorBlurb: string | null;
    oneLiner: string | null;
  };
} | null> {
  const lead = await db.query.founderLeads.findFirst({
    where: eq(founderLeads.id, sessionId),
  });

  if (!lead) {
    return null;
  }

  return {
    id: lead.id,
    status: lead.status,
    conversationHistory: lead.conversationHistory
      ? JSON.parse(lead.conversationHistory)
      : [],
    extractedData: {
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      companyName: lead.companyName,
      companyDescription: lead.companyDescription,
      sector: lead.sector,
      primaryPersona: lead.primaryPersona,
      secondaryPersona: lead.secondaryPersona,
      fundraisingExperience: lead.fundraisingExperience,
      investorNetworkNumber: lead.investorNetworkNumber,
      investorNetworkRange: lead.investorNetworkRange,
      companyStage: lead.companyStage,
      geographyContext: lead.geographyContext,
    },
    outputs: lead.status === 'completed'
      ? {
          investorBlurb: lead.investorBlurb,
          oneLiner: lead.oneLiner,
        }
      : undefined,
  };
}
