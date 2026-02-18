import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, investors } from '../db/index.js';
import {
  startInvestorResearch,
  getLatestResearch,
  canTriggerResearch,
  getResearchById,
} from '../services/research-agent.js';

const app = new Hono();

/**
 * Get latest research for an investor
 * GET /investors/:id/research
 */
app.get('/:id/research', async (c) => {
  const investorId = parseInt(c.req.param('id'));

  // Verify investor exists
  const investor = await db.query.investors.findFirst({
    where: eq(investors.id, investorId),
  });

  if (!investor) {
    return c.json({ error: 'Investor not found' }, 404);
  }

  const research = await getLatestResearch(investorId);
  const rateLimit = await canTriggerResearch(investorId);

  return c.json({
    investor: {
      id: investor.id,
      name: investor.name,
      firm: investor.firm,
    },
    research,
    canTriggerResearch: rateLimit.allowed,
    lastResearchedAt: rateLimit.lastResearchedAt,
  });
});

/**
 * Trigger new research for an investor
 * POST /investors/:id/research
 */
app.post('/:id/research', async (c) => {
  const investorId = parseInt(c.req.param('id'));

  // Verify investor exists
  const investor = await db.query.investors.findFirst({
    where: eq(investors.id, investorId),
  });

  if (!investor) {
    return c.json({ error: 'Investor not found' }, 404);
  }

  // Check rate limit
  const rateLimit = await canTriggerResearch(investorId);
  if (!rateLimit.allowed) {
    return c.json(
      {
        error: 'Research was performed within the last 24 hours. Please wait before triggering again.',
        lastResearchedAt: rateLimit.lastResearchedAt,
      },
      429
    );
  }

  // Start research
  const { researchId, alreadyResearching } = await startInvestorResearch(investorId);

  return c.json(
    {
      researchId,
      status: alreadyResearching ? 'already_in_progress' : 'started',
      message: alreadyResearching
        ? 'Research is already in progress'
        : 'Research started. Poll the status endpoint for updates.',
    },
    202
  );
});

/**
 * Get research status by ID
 * GET /investors/:id/research/:researchId/status
 */
app.get('/:id/research/:researchId/status', async (c) => {
  const investorId = parseInt(c.req.param('id'));
  const researchId = parseInt(c.req.param('researchId'));

  const research = await getResearchById(researchId);

  if (!research || research.investorId !== investorId) {
    return c.json({ error: 'Research not found' }, 404);
  }

  return c.json(research);
});

export default app;
