/**
 * AI-powered investor research agent
 * Uses Serper API for web search and Claude API for analysis
 */

import { db, investorResearch, investors } from '../db/index.js';
import { eq, desc, and, inArray } from 'drizzle-orm';

const SERPER_API_URL = 'https://google.serper.dev/search';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

interface SerperResult {
  title: string;
  link: string;
  snippet: string;
}

interface SerperResponse {
  organic: SerperResult[];
}

interface ResearchResult {
  bio: string | null;
  investmentThesis: string | null;
  portfolioCompanies: string[];
  founderPreferences: string | null;
  recentActivity: string | null;
  sourceUrls: string[];
}

/**
 * Search the web using Serper API
 */
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

/**
 * Analyze search results with Claude Haiku
 */
async function analyzeWithClaude(
  investorName: string,
  firmName: string | null,
  searchResults: SerperResult[],
  apiKey: string
): Promise<ResearchResult> {
  const context = searchResults
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`)
    .join('\n\n');

  const prompt = `You are researching an investor for a startup founder who wants to get an introduction.

Investor: ${investorName}${firmName ? ` at ${firmName}` : ''}

Based on the following search results, extract key information about this investor. Be concise but informative.

Search Results:
${context}

Respond in JSON format with these fields (use null if information is not available):
{
  "bio": "Brief background (2-3 sentences about their career, education, notable achievements)",
  "investmentThesis": "What they look for in startups (sectors, stages, geographies, company characteristics)",
  "portfolioCompanies": ["Company1", "Company2", ...] (notable investments, max 10),
  "founderPreferences": "Types of founders they prefer (backgrounds, traits, what they value)",
  "recentActivity": "Recent investments, announcements, or news (1-2 sentences)"
}

Important:
- Only include information that appears in the search results
- Be specific and factual, avoid generic statements
- If a field has no relevant information, use null
- For portfolioCompanies, only list companies explicitly mentioned`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || '{}';

  // Extract JSON from the response (it might be wrapped in markdown)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse Claude response as JSON');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    // Try to fix common JSON issues
    let cleanedJson = jsonMatch[0]
      .replace(/,\s*}/g, '}')  // Remove trailing commas before }
      .replace(/,\s*]/g, ']')  // Remove trailing commas before ]
      .replace(/[\u0000-\u001F]+/g, ' ')  // Remove control characters
      .replace(/\n/g, ' ')  // Replace newlines with spaces
      .replace(/\r/g, '');  // Remove carriage returns

    try {
      parsed = JSON.parse(cleanedJson);
    } catch (e2) {
      console.error('JSON parse error. Raw content:', content.substring(0, 500));
      throw new Error('Failed to parse Claude response as JSON');
    }
  }

  return {
    bio: parsed.bio || null,
    investmentThesis: parsed.investmentThesis || null,
    portfolioCompanies: Array.isArray(parsed.portfolioCompanies) ? parsed.portfolioCompanies : [],
    founderPreferences: parsed.founderPreferences || null,
    recentActivity: parsed.recentActivity || null,
    sourceUrls: searchResults.map((r) => r.link),
  };
}

/**
 * Perform comprehensive investor research
 */
export async function performInvestorResearch(investorId: number, researchId: number): Promise<void> {
  const serperApiKey = process.env.SERPER_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!serperApiKey || !anthropicApiKey) {
    await db
      .update(investorResearch)
      .set({
        status: 'failed',
        errorMessage: 'Missing API keys (SERPER_API_KEY or ANTHROPIC_API_KEY)',
      })
      .where(eq(investorResearch.id, researchId));
    return;
  }

  // Mark as in progress
  await db
    .update(investorResearch)
    .set({ status: 'in_progress' })
    .where(eq(investorResearch.id, researchId));

  try {
    // Get investor details
    const investor = await db.query.investors.findFirst({
      where: eq(investors.id, investorId),
    });

    if (!investor) {
      throw new Error('Investor not found');
    }

    const investorName = investor.name;
    const firmName = investor.firm;

    // Build search queries for comprehensive coverage
    const queries = [
      `${investorName}${firmName ? ` ${firmName}` : ''} investor`,
      `${investorName}${firmName ? ` ${firmName}` : ''} portfolio investments`,
      `${investorName}${firmName ? ` ${firmName}` : ''} investment thesis philosophy`,
    ];

    // Execute searches
    const allResults: SerperResult[] = [];
    for (const query of queries) {
      try {
        const results = await webSearch(query, serperApiKey);
        allResults.push(...results);
      } catch (err) {
        console.error(`Search failed for query "${query}":`, err);
      }
    }

    // Deduplicate by URL
    const seenUrls = new Set<string>();
    const uniqueResults = allResults.filter((r) => {
      if (seenUrls.has(r.link)) return false;
      seenUrls.add(r.link);
      return true;
    });

    // Take top 15 results for analysis
    const topResults = uniqueResults.slice(0, 15);

    if (topResults.length === 0) {
      throw new Error('No search results found');
    }

    // Analyze with Claude
    const analysis = await analyzeWithClaude(investorName, firmName, topResults, anthropicApiKey);

    // Save results
    const now = new Date().toISOString();
    await db
      .update(investorResearch)
      .set({
        status: 'completed',
        bio: analysis.bio,
        investmentThesis: analysis.investmentThesis,
        portfolioCompanies: JSON.stringify(analysis.portfolioCompanies),
        founderPreferences: analysis.founderPreferences,
        recentActivity: analysis.recentActivity,
        sourceUrls: JSON.stringify(analysis.sourceUrls),
        researchedAt: now,
        errorMessage: null,
      })
      .where(eq(investorResearch.id, researchId));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await db
      .update(investorResearch)
      .set({
        status: 'failed',
        errorMessage,
      })
      .where(eq(investorResearch.id, researchId));
  }
}

/**
 * Create a new research record and start research in background
 */
export async function startInvestorResearch(
  investorId: number
): Promise<{ researchId: number; alreadyResearching: boolean }> {
  const now = new Date().toISOString();

  // Check if there's already in-progress research
  const inProgress = await db.query.investorResearch.findFirst({
    where: and(
      eq(investorResearch.investorId, investorId),
      inArray(investorResearch.status, ['pending', 'in_progress'])
    ),
  });

  if (inProgress) {
    return { researchId: inProgress.id, alreadyResearching: true };
  }

  // Create new research record
  const result = await db
    .insert(investorResearch)
    .values({
      investorId,
      status: 'pending',
      createdAt: now,
    })
    .returning();

  const researchId = result[0].id;

  // Start research in background (don't await)
  performInvestorResearch(investorId, researchId).catch((err) => {
    console.error('Background research failed:', err);
  });

  return { researchId, alreadyResearching: false };
}

/**
 * Get the latest research for an investor
 */
export async function getLatestResearch(investorId: number) {
  const research = await db.query.investorResearch.findFirst({
    where: eq(investorResearch.investorId, investorId),
    orderBy: [desc(investorResearch.createdAt)],
  });

  if (!research) return null;

  return {
    id: research.id,
    status: research.status,
    bio: research.bio,
    investmentThesis: research.investmentThesis,
    portfolioCompanies: research.portfolioCompanies ? JSON.parse(research.portfolioCompanies) : [],
    founderPreferences: research.founderPreferences,
    recentActivity: research.recentActivity,
    sourceUrls: research.sourceUrls ? JSON.parse(research.sourceUrls) : [],
    errorMessage: research.errorMessage,
    researchedAt: research.researchedAt,
    createdAt: research.createdAt,
  };
}

/**
 * Check if research can be triggered (24hr rate limit)
 */
export async function canTriggerResearch(
  investorId: number
): Promise<{ allowed: boolean; lastResearchedAt: string | null }> {
  const latest = await db.query.investorResearch.findFirst({
    where: and(
      eq(investorResearch.investorId, investorId),
      eq(investorResearch.status, 'completed')
    ),
    orderBy: [desc(investorResearch.researchedAt)],
  });

  if (!latest?.researchedAt) {
    return { allowed: true, lastResearchedAt: null };
  }

  const lastResearched = new Date(latest.researchedAt);
  const now = new Date();
  const hoursSinceLastResearch = (now.getTime() - lastResearched.getTime()) / (1000 * 60 * 60);

  return {
    allowed: hoursSinceLastResearch >= 24,
    lastResearchedAt: latest.researchedAt,
  };
}

/**
 * Get research by ID
 */
export async function getResearchById(researchId: number) {
  const research = await db.query.investorResearch.findFirst({
    where: eq(investorResearch.id, researchId),
  });

  if (!research) return null;

  return {
    id: research.id,
    investorId: research.investorId,
    status: research.status,
    bio: research.bio,
    investmentThesis: research.investmentThesis,
    portfolioCompanies: research.portfolioCompanies ? JSON.parse(research.portfolioCompanies) : [],
    founderPreferences: research.founderPreferences,
    recentActivity: research.recentActivity,
    sourceUrls: research.sourceUrls ? JSON.parse(research.sourceUrls) : [],
    errorMessage: research.errorMessage,
    researchedAt: research.researchedAt,
    createdAt: research.createdAt,
  };
}
