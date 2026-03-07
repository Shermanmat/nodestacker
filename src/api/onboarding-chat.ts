/**
 * Conversational onboarding API for founder intake
 * Public endpoints - no auth required
 */

import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db, founderLeads } from '../db/index.js';
import { createSession, processMessage, getSession } from '../services/onboarding-ai.js';
import { z } from 'zod';

const app = new Hono();

// Start a new onboarding conversation
app.post('/start', async (c) => {
  try {
    const { sessionId, openingMessage } = await createSession();

    return c.json({
      sessionId,
      message: openingMessage,
    }, 201);
  } catch (err) {
    console.error('Failed to start onboarding session:', err);
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to start session',
    }, 500);
  }
});

// Send a message in an existing conversation
const messageSchema = z.object({
  message: z.string().min(1),
});

app.post('/:sessionId/message', async (c) => {
  const sessionId = parseInt(c.req.param('sessionId'));

  if (isNaN(sessionId)) {
    return c.json({ error: 'Invalid session ID' }, 400);
  }

  const body = await c.req.json();
  const parsed = messageSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Message is required' }, 400);
  }

  try {
    const result = await processMessage(sessionId, parsed.data.message);

    return c.json({
      message: result.response,
      isComplete: result.isComplete,
      outputs: result.outputs,
    });
  } catch (err) {
    console.error('Failed to process message:', err);
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to process message',
    }, 500);
  }
});

// Get conversation state
app.get('/:sessionId', async (c) => {
  const sessionId = parseInt(c.req.param('sessionId'));

  if (isNaN(sessionId)) {
    return c.json({ error: 'Invalid session ID' }, 400);
  }

  try {
    const session = await getSession(sessionId);

    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    return c.json(session);
  } catch (err) {
    console.error('Failed to get session:', err);
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to get session',
    }, 500);
  }
});

// Admin: List all founder leads (protected by admin guard in index.ts)
app.get('/leads', async (c) => {
  const status = c.req.query('status');

  let leads = await db
    .select()
    .from(founderLeads)
    .orderBy(desc(founderLeads.createdAt));

  if (status) {
    leads = leads.filter(l => l.status === status);
  }

  // Parse conversation history for each lead
  const parsed = leads.map(lead => ({
    ...lead,
    conversationHistory: lead.conversationHistory
      ? JSON.parse(lead.conversationHistory)
      : [],
  }));

  return c.json(parsed);
});

// Admin: Get single lead details (protected by admin guard in index.ts)
app.get('/leads/:id', async (c) => {
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return c.json({ error: 'Invalid lead ID' }, 400);
  }

  const lead = await db.query.founderLeads.findFirst({
    where: eq(founderLeads.id, id),
  });

  if (!lead) {
    return c.json({ error: 'Lead not found' }, 404);
  }

  return c.json({
    ...lead,
    conversationHistory: lead.conversationHistory
      ? JSON.parse(lead.conversationHistory)
      : [],
  });
});

// Admin: Convert lead to founder
app.post('/leads/:id/convert', async (c) => {
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return c.json({ error: 'Invalid lead ID' }, 400);
  }

  const lead = await db.query.founderLeads.findFirst({
    where: eq(founderLeads.id, id),
  });

  if (!lead) {
    return c.json({ error: 'Lead not found' }, 404);
  }

  if (lead.status !== 'completed') {
    return c.json({ error: 'Lead must be completed before converting' }, 400);
  }

  if (!lead.firstName || !lead.lastName || !lead.email || !lead.companyName) {
    return c.json({ error: 'Lead missing required fields' }, 400);
  }

  // TODO: Create founder from lead data
  // This would create a new founder record and link it

  const now = new Date().toISOString();
  await db
    .update(founderLeads)
    .set({
      status: 'converted',
      // convertedFounderId would be set here after creating the founder
    })
    .where(eq(founderLeads.id, id));

  return c.json({
    success: true,
    message: 'Lead marked as converted. Create founder record manually for now.',
  });
});

export default app;
