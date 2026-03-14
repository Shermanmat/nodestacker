/**
 * AI-powered voice interview agent
 * Researches a founder's company using Serper + Claude, generates tailored questions
 */

import { db, voiceInterviews, voiceInterviewAnswers, publicCompanies, publicUsers, founderLeads } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { sendVoiceInterviewEmail, notifyAdminInterviewCompleted } from './onboarding-emails.js';

const SERPER_API_URL = 'https://google.serper.dev/search';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const FALLBACK_QUESTIONS = [
  { question: "What problem are you solving and who are you solving it for?", reason: "Understanding the core value proposition" },
  { question: "How does your solution work today?", reason: "Understanding the product and approach" },
  { question: "What traction or validation have you seen so far?", reason: "Assessing progress and market fit" },
  { question: "Why are you the right person to build this?", reason: "Understanding founder-market fit" },
  { question: "What would MatCap's support mean for your company right now?", reason: "Understanding where they need help" },
];

interface SerperResult {
  title: string;
  link: string;
  snippet: string;
}

interface SerperResponse {
  organic: SerperResult[];
}

interface InterviewQuestion {
  question: string;
  reason: string;
}

interface ResearchOutput {
  research: string;
  questions: InterviewQuestion[];
}

async function webSearch(query: string, apiKey: string): Promise<SerperResult[]> {
  const response = await fetch(SERPER_API_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: 10 }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Serper API error: ${response.status} - ${text}`);
  }

  const data = (await response.json()) as SerperResponse;
  return data.organic || [];
}

async function generateQuestions(
  companyName: string,
  founderName: string,
  sector: string | null,
  oneLiner: string | null,
  companyUrl: string | null,
  searchResults: SerperResult[],
  apiKey: string
): Promise<ResearchOutput> {
  const context = searchResults
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`)
    .join('\n\n');

  const prompt = `You are helping evaluate a startup founder who has applied to join MatCap, a portfolio accelerator. Research the company and generate tailored interview questions.

## Application Details
- **Founder**: ${founderName}
- **Company**: ${companyName}
${sector ? `- **Sector**: ${sector}` : ''}
${oneLiner ? `- **Description**: ${oneLiner}` : ''}
${companyUrl ? `- **URL**: ${companyUrl}` : ''}

## Web Search Results
${context || 'No search results available.'}

## Instructions
1. Summarize what you know about this company and its market (2-3 paragraphs)
2. Identify 3-5 gaps, unclear areas, or things worth probing deeper on
3. Generate a tailored question for each gap — questions should be specific to THIS company, not generic

Return JSON in this exact format:
{
  "research": "Your research summary here...",
  "questions": [
    { "question": "Your specific question here?", "reason": "Brief explanation of why you're asking this" }
  ]
}

Important:
- Make questions conversational and warm — the founder will record audio answers
- Reference specific things from the research (their market, competitors, claims)
- Avoid yes/no questions — ask open-ended questions that reveal clarity of thought
- 3-5 questions total`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || '{}';

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse Claude response as JSON');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    const cleaned = jsonMatch[0]
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/[\u0000-\u001F]+/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\r/g, '');
    parsed = JSON.parse(cleaned);
  }

  return {
    research: parsed.research || '',
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
  };
}

/**
 * Perform research and generate interview questions (runs in background)
 */
export async function performInterviewResearch(interviewId: number): Promise<void> {
  const serperApiKey = process.env.SERPER_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  try {
    // Get interview + company + user details
    const interview = await db.query.voiceInterviews.findFirst({
      where: eq(voiceInterviews.id, interviewId),
    });
    if (!interview) throw new Error('Interview not found');

    const company = await db.query.publicCompanies.findFirst({
      where: eq(publicCompanies.id, interview.publicCompanyId),
    });
    if (!company) throw new Error('Company not found');

    const user = await db.query.publicUsers.findFirst({
      where: eq(publicUsers.id, company.userId),
    });
    if (!user) throw new Error('User not found');

    const founderName = `${user.firstName} ${user.lastName}`;
    const companyName = company.companyName;
    const sector = company.sector;
    const oneLiner = company.oneLiner;
    const companyUrl = company.url;

    // Also check if there's a founder lead with more context
    const lead = await db.query.founderLeads.findFirst({
      where: eq(founderLeads.publicCompanyId, company.id),
    });
    const description = lead?.companyDescription || oneLiner;

    let result: ResearchOutput;

    if (!serperApiKey || !anthropicApiKey) {
      console.log('[VOICE-INTERVIEW] Missing API keys, using fallback questions');
      result = { research: '', questions: FALLBACK_QUESTIONS };
    } else {
      // Web search
      const queries = [
        `"${companyName}" ${sector || ''}`.trim(),
        `"${companyName}" ${founderName} startup`,
        `${sector || 'startup'} market trends challenges`,
      ];

      const allResults: SerperResult[] = [];
      for (const query of queries) {
        try {
          const results = await webSearch(query, serperApiKey);
          allResults.push(...results);
        } catch (err) {
          console.error(`[VOICE-INTERVIEW] Search failed for "${query}":`, err);
        }
      }

      // Deduplicate
      const seenUrls = new Set<string>();
      const uniqueResults = allResults.filter((r) => {
        if (seenUrls.has(r.link)) return false;
        seenUrls.add(r.link);
        return true;
      }).slice(0, 15);

      try {
        result = await generateQuestions(
          companyName, founderName, sector, description, companyUrl,
          uniqueResults, anthropicApiKey
        );
        if (result.questions.length === 0) {
          result.questions = FALLBACK_QUESTIONS;
        }
      } catch (err) {
        console.error('[VOICE-INTERVIEW] Question generation failed:', err);
        result = { research: '', questions: FALLBACK_QUESTIONS };
      }
    }

    // Save results and send email
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48 hours

    await db.update(voiceInterviews).set({
      status: 'sent',
      research: result.research,
      questions: JSON.stringify(result.questions),
      sentAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }).where(eq(voiceInterviews.id, interviewId));

    // Update application status
    await db.update(publicCompanies).set({
      applicationStatus: 'interview_sent',
    }).where(eq(publicCompanies.id, interview.publicCompanyId));

    // Send email to founder
    const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
    const interviewUrl = `${BASE_URL}/voice-interview?token=${interview.token}`;

    await sendVoiceInterviewEmail(
      user.email,
      user.firstName,
      companyName,
      interviewUrl
    );

    console.log(`[VOICE-INTERVIEW] Research complete, email sent for interview #${interviewId}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[VOICE-INTERVIEW] Failed for interview #${interviewId}:`, errorMessage);

    await db.update(voiceInterviews).set({
      status: 'failed',
      research: errorMessage,
    }).where(eq(voiceInterviews.id, interviewId));
  }
}

/**
 * Start a voice interview for a company application
 */
export async function startVoiceInterview(publicCompanyId: number): Promise<{ interviewId: number; alreadyExists: boolean }> {
  // Check for existing active interview
  const existing = await db.query.voiceInterviews.findFirst({
    where: eq(voiceInterviews.publicCompanyId, publicCompanyId),
  });

  if (existing && (existing.status === 'researching' || existing.status === 'sent')) {
    return { interviewId: existing.id, alreadyExists: true };
  }

  const token = crypto.randomUUID();
  const now = new Date().toISOString();

  const [interview] = await db.insert(voiceInterviews).values({
    publicCompanyId,
    token,
    status: 'researching',
    createdAt: now,
  }).returning();

  // Update application status
  await db.update(publicCompanies).set({
    applicationStatus: 'interview_sent',
  }).where(eq(publicCompanies.id, publicCompanyId));

  // Start research in background
  performInterviewResearch(interview.id).catch((err) => {
    console.error('[VOICE-INTERVIEW] Background research failed:', err);
  });

  return { interviewId: interview.id, alreadyExists: false };
}
