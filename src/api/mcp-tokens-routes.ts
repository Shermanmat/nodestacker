/**
 * MCP token management — a logged-in founder mints, lists, and revokes their own
 * MCP access tokens here. Session-authed (the founder portal's X-Session-Id), and
 * intentionally NOT behind the CRM trial gate: a founder must always be able to
 * see and revoke their tokens, even if their pipeline access is read-only.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getSessionFounderId } from './auth.js';
import { mintToken, listTokens, revokeToken } from '../services/mcp-tokens.js';

type Variables = { founderId: number };
const app = new Hono<{ Variables: Variables }>();

app.use('*', async (c, next) => {
  const founderId = getSessionFounderId(c.req.header('X-Session-Id'));
  if (!founderId) return c.json({ error: 'Unauthorized' }, 401);
  c.set('founderId', founderId);
  await next();
});

const mintSchema = z.object({
  name: z.string().max(120).nullable().optional(),
  expiresInDays: z.number().int().positive().max(3650).nullable().optional(),
});

// POST /  → create a token. Returns the raw token ONCE (not retrievable later).
app.post('/', async (c) => {
  const parsed = mintSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { token, record } = await mintToken(c.get('founderId'), {
    name: parsed.data.name ?? null,
    expiresInDays: parsed.data.expiresInDays ?? null,
  });
  return c.json({
    token,
    record,
    note: 'Copy this token now — it will not be shown again. Set it as MATCAP_MCP_TOKEN in your MCP client.',
  }, 201);
});

// GET /  → list this founder's tokens (metadata only — never the secret).
app.get('/', async (c) => {
  return c.json({ tokens: await listTokens(c.get('founderId')) });
});

// DELETE /:id  → revoke. Scoped to the founder, so you can't revoke another's.
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
  const ok = await revokeToken(c.get('founderId'), id);
  if (!ok) return c.json({ error: 'Token not found' }, 404);
  return c.json({ ok: true, revoked: id });
});

export default app;
