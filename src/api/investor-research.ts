import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db, investors, investorResearch } from '../db/index.js';
import {
  startInvestorResearch,
  getLatestResearch,
  canTriggerResearch,
  getResearchById,
  performInvestorResearch,
} from '../services/research-agent.js';

// Bulk research state
let bulkResearchStatus = {
  running: false,
  total: 0,
  completed: 0,
  failed: 0,
  current: '',
  startedAt: null as string | null,
  completedAt: null as string | null,
  results: [] as { investorId: number; name: string; status: 'success' | 'failed' | 'skipped'; error?: string }[],
};

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

/**
 * Start bulk research on all investors
 * POST /investors/bulk-research
 */
app.post('/bulk-research', async (c) => {
  if (bulkResearchStatus.running) {
    return c.json({
      error: 'Bulk research already in progress',
      status: bulkResearchStatus,
    }, 409);
  }

  // Get all investors
  const allInvestors = await db.select().from(investors);

  // Get investors with completed research
  const completedResearch = await db.select()
    .from(investorResearch)
    .where(eq(investorResearch.status, 'completed'));

  const researchedIds = new Set(completedResearch.map(r => r.investorId));

  // Filter to investors without research
  const needsResearch = allInvestors.filter(inv => !researchedIds.has(inv.id));

  if (needsResearch.length === 0) {
    return c.json({
      message: 'All investors already have research',
      total: allInvestors.length,
    });
  }

  // Reset status
  bulkResearchStatus = {
    running: true,
    total: needsResearch.length,
    completed: 0,
    failed: 0,
    current: '',
    startedAt: new Date().toISOString(),
    completedAt: null,
    results: [],
  };

  // Run research in background
  (async () => {
    for (const inv of needsResearch) {
      bulkResearchStatus.current = `${inv.name} (${inv.firm || 'No firm'})`;

      try {
        // Create research record
        const now = new Date().toISOString();
        const result = await db
          .insert(investorResearch)
          .values({
            investorId: inv.id,
            status: 'pending',
            createdAt: now,
          })
          .returning();

        // Perform research synchronously
        await performInvestorResearch(inv.id, result[0].id);

        // Check if it succeeded
        const researchResult = await getResearchById(result[0].id);
        if (researchResult?.status === 'completed') {
          bulkResearchStatus.completed++;
          bulkResearchStatus.results.push({ investorId: inv.id, name: inv.name, status: 'success' });
        } else {
          bulkResearchStatus.failed++;
          bulkResearchStatus.results.push({
            investorId: inv.id,
            name: inv.name,
            status: 'failed',
            error: researchResult?.errorMessage || 'Unknown error',
          });
        }
      } catch (err) {
        bulkResearchStatus.failed++;
        bulkResearchStatus.results.push({
          investorId: inv.id,
          name: inv.name,
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    bulkResearchStatus.running = false;
    bulkResearchStatus.current = '';
    bulkResearchStatus.completedAt = new Date().toISOString();
    console.log(`Bulk research complete: ${bulkResearchStatus.completed} succeeded, ${bulkResearchStatus.failed} failed`);
  })();

  return c.json({
    message: 'Bulk research started',
    total: needsResearch.length,
    skipped: allInvestors.length - needsResearch.length,
  }, 202);
});

/**
 * Get bulk research status
 * GET /investors/bulk-research/status
 */
app.get('/bulk-research/status', async (c) => {
  return c.json(bulkResearchStatus);
});

export default app;
