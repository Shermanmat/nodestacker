/**
 * Formation Document Extraction Service
 *
 * Reads a company's prior formation documents — Articles of Incorporation (AOC),
 * bylaws, and initial board consent — and extracts the structured variables the
 * onboarding workflow needs (entity name, state, type, authorized shares, par
 * value, officers, board members, incorporation date).
 *
 * Used by the docs-first onboarding track: already-incorporated companies upload
 * their formation docs instead of typing entity info by hand. Claude reads the
 * PDFs natively (no OCR), extracts variables, and flags cross-document
 * inconsistencies for the founder to resolve before anything is saved.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export type FormationDocKind = 'aoc' | 'bylaws' | 'board_consent';

export interface ExtractedBoardMember {
  name: string;
  title: string | null;
  /** Email is rarely present in formation docs; founder fills these in on confirm. */
  email: string | null;
}

export interface ExtractedFormationData {
  entityName: string | null;
  /** Normalized to the onboarding entity_type enum where possible. */
  entityType: 'llc' | 'c_corp' | 's_corp' | 'partnership' | 'sole_prop' | 'other' | null;
  /** 2-char US state code (state of incorporation). */
  entityState: string | null;
  /** ISO date (YYYY-MM-DD) the entity was incorporated, if stated. */
  incorporationDate: string | null;
  authorizedShares: number | null;
  /** Par value / price per share as a string (e.g. "0.0001"). */
  parValue: string | null;
  registeredAgent: string | null;
  officers: { name: string; title: string }[];
  boardMembers: ExtractedBoardMember[];
  /**
   * Cross-document inconsistencies or missing-required-data notes the founder
   * must review before confirming (e.g. entity name differs between AOC and
   * bylaws, board consent not signed/dated, share count absent).
   */
  warnings: string[];
  /** Model's self-assessed confidence in the extraction. */
  confidence: 'high' | 'medium' | 'low';
}

const EXTRACTION_PROMPT = `You are a corporate paralegal extracting structured data from a company's formation documents. You are given three documents:

1. ARTICLES_OF_INCORPORATION (AOC) — the authoritative source for entity name, state, type, authorized shares, and par value.
2. BYLAWS — officer roles, share classes, board structure.
3. INITIAL_BOARD_CONSENT — the initial board members and the officers/board they appointed, plus the consent date.

Extract the following and return ONLY a JSON object (no prose, no markdown fences):

{
  "entityName": string | null,            // exact legal name from the AOC
  "entityType": "llc" | "c_corp" | "s_corp" | "partnership" | "sole_prop" | "other" | null,
  "entityState": string | null,           // 2-letter US state code of incorporation (e.g. "DE")
  "incorporationDate": string | null,     // YYYY-MM-DD if stated, else null
  "authorizedShares": number | null,      // total authorized shares from the AOC
  "parValue": string | null,              // par value per share as a string, e.g. "0.0001"
  "registeredAgent": string | null,
  "officers": [ { "name": string, "title": string } ],
  "boardMembers": [ { "name": string, "title": string | null, "email": string | null } ],
  "warnings": [ string ],
  "confidence": "high" | "medium" | "low"
}

Rules:
- entityType: a stock corporation that has not elected S-corp status is "c_corp". Map "Inc." / "Corporation" with authorized shares to "c_corp" unless the docs explicitly say S-corp.
- Board members come from the INITIAL_BOARD_CONSENT. If the consent lists directors, use those. Emails are usually absent — set email to null; do not guess.
- warnings MUST flag, as separate strings: (a) the entity name not matching across all three documents; (b) the board consent being unsigned or undated; (c) any required field (entity name, state, authorized shares) that you could not find; (d) authorized shares in the AOC disagreeing with anything in the bylaws.
- Never invent values. Use null when a value is not present in the documents.
- Return strictly valid JSON.`;

/** Map a document kind to the label Claude sees in the prompt. */
const DOC_LABELS: Record<FormationDocKind, string> = {
  aoc: 'ARTICLES_OF_INCORPORATION',
  bylaws: 'BYLAWS',
  board_consent: 'INITIAL_BOARD_CONSENT',
};

function parseJsonResponse(content: string): any {
  const jsonMatch =
    content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]).trim() : content;
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const cleaned = jsonStr
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/[\x00-\x1F]+/g, ' ');
    return JSON.parse(cleaned);
  }
}

/** Coerce/clean the raw model output into ExtractedFormationData. */
function normalize(raw: any): ExtractedFormationData {
  const VALID_TYPES = ['llc', 'c_corp', 's_corp', 'partnership', 'sole_prop', 'other'];
  const entityType =
    raw?.entityType && VALID_TYPES.includes(raw.entityType) ? raw.entityType : null;
  const entityState =
    typeof raw?.entityState === 'string' && raw.entityState.trim().length === 2
      ? raw.entityState.trim().toUpperCase()
      : null;
  const authorizedShares =
    typeof raw?.authorizedShares === 'number' && Number.isFinite(raw.authorizedShares)
      ? Math.round(raw.authorizedShares)
      : null;

  const officers = Array.isArray(raw?.officers)
    ? raw.officers
        .filter((o: any) => o && typeof o.name === 'string')
        .map((o: any) => ({ name: o.name.trim(), title: String(o.title || '').trim() }))
    : [];

  const boardMembers = Array.isArray(raw?.boardMembers)
    ? raw.boardMembers
        .filter((m: any) => m && typeof m.name === 'string')
        .map((m: any) => ({
          name: m.name.trim(),
          title: m.title ? String(m.title).trim() : null,
          email: m.email && typeof m.email === 'string' ? m.email.trim() : null,
        }))
    : [];

  const warnings = Array.isArray(raw?.warnings)
    ? raw.warnings.filter((w: any) => typeof w === 'string')
    : [];

  return {
    entityName: raw?.entityName ? String(raw.entityName).trim() : null,
    entityType,
    entityState,
    incorporationDate: raw?.incorporationDate ? String(raw.incorporationDate).trim() : null,
    authorizedShares,
    parValue: raw?.parValue != null ? String(raw.parValue).trim() : null,
    registeredAgent: raw?.registeredAgent ? String(raw.registeredAgent).trim() : null,
    officers,
    boardMembers,
    warnings,
    confidence: ['high', 'medium', 'low'].includes(raw?.confidence) ? raw.confidence : 'low',
  };
}

/**
 * Extract structured formation data from the three required documents.
 * Each doc is the raw PDF bytes. Throws if ANTHROPIC_API_KEY is unset or the
 * API call fails; the caller is responsible for surfacing that to the founder.
 */
export async function extractFormationDocuments(docs: {
  aoc: Buffer;
  bylaws: Buffer;
  boardConsent: Buffer;
}): Promise<ExtractedFormationData> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const order: { kind: FormationDocKind; buf: Buffer }[] = [
    { kind: 'aoc', buf: docs.aoc },
    { kind: 'bylaws', buf: docs.bylaws },
    { kind: 'board_consent', buf: docs.boardConsent },
  ];

  // Interleave a label before each PDF so the model knows which doc is which.
  const content: any[] = [];
  for (const { kind, buf } of order) {
    content.push({ type: 'text', text: `=== ${DOC_LABELS[kind]} ===` });
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: buf.toString('base64'),
      },
    });
  }
  content.push({
    type: 'text',
    text: 'Extract the JSON object as instructed. Return only the JSON.',
  });

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: EXTRACTION_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  const raw = parseJsonResponse(text);
  return normalize(raw);
}
