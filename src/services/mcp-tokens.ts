/**
 * MCP access tokens — founder-scoped credentials for connecting an AI client to
 * the pipeline via the MCP server.
 *
 * Security model:
 *  - The raw token is shown to the founder exactly ONCE, at creation. We store
 *    only its SHA-256 hash, so a database leak cannot reconstruct a usable token.
 *  - Verification hashes the presented token and does a single indexed lookup,
 *    then checks it isn't revoked or expired. The token resolves to exactly one
 *    founderId — that id is what scopes every downstream data operation.
 *  - Tokens are revocable and can carry an optional expiry.
 */

import { createHash, randomBytes } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db, mcpTokens, type McpToken } from '../db/index.js';

const TOKEN_BYTES = 32;            // 256 bits of entropy
const PREFIX_LABEL = 'mcp_';       // human-recognizable scheme prefix

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface MintResult {
  /** The raw token — return to the founder ONCE; never retrievable again. */
  token: string;
  record: Omit<McpToken, 'tokenHash'>;
}

/**
 * Create a new token for a founder. `expiresInDays` is optional (null = no expiry).
 */
export async function mintToken(
  founderId: number,
  opts: { name?: string | null; expiresInDays?: number | null } = {},
): Promise<MintResult> {
  const raw = PREFIX_LABEL + randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(raw);
  const tokenPrefix = raw.slice(0, 12); // 'mcp_' + 8 hex chars — display only

  const now = new Date().toISOString();
  const expiresAt = opts.expiresInDays && opts.expiresInDays > 0
    ? new Date(Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const [row] = await db.insert(mcpTokens).values({
    founderId,
    tokenHash,
    tokenPrefix,
    name: opts.name ?? null,
    createdAt: now,
    expiresAt,
  }).returning();

  const { tokenHash: _omit, ...safe } = row;
  return { token: raw, record: safe };
}

/**
 * Resolve a raw token to its owning founderId, or null if invalid/expired/revoked.
 * Updates lastUsedAt on success (best-effort).
 */
export async function verifyToken(raw: string | undefined | null): Promise<number | null> {
  if (!raw || !raw.startsWith(PREFIX_LABEL)) return null;

  const tokenHash = hashToken(raw);
  const [row] = await db.select().from(mcpTokens).where(eq(mcpTokens.tokenHash, tokenHash));
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt <= new Date().toISOString()) return null;

  // Best-effort usage stamp; never block auth on it.
  try {
    await db.update(mcpTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(mcpTokens.id, row.id));
  } catch { /* non-fatal */ }

  return row.founderId;
}

/** List a founder's tokens (metadata only — never the hash). */
export async function listTokens(founderId: number): Promise<Array<Omit<McpToken, 'tokenHash'>>> {
  const rows = await db.select().from(mcpTokens).where(eq(mcpTokens.founderId, founderId));
  return rows.map(({ tokenHash: _h, ...rest }) => rest);
}

/**
 * Revoke a token by id, scoped to the owning founder so one founder can't revoke
 * another's. Returns true if a row was revoked.
 */
export async function revokeToken(founderId: number, tokenId: number): Promise<boolean> {
  const [row] = await db.update(mcpTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(
      eq(mcpTokens.id, tokenId),
      eq(mcpTokens.founderId, founderId),
    ))
    .returning();
  return !!row && !!row.revokedAt;
}
