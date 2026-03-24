/**
 * Blurb Builder API — AI-powered startup pitch tool
 * Public endpoints (no auth required)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sql, eq, and, or, inArray } from 'drizzle-orm';
import { db, founderLeads, investors, investorCategories, investorCategoryAssignments, investorCategoryExclusions, nodeInvestorConnections } from '../db/index.js';
import { analyzeSignals, generateBlurb } from '../services/blurb-ai.js';
import { sendEmail } from '../services/email.js';

const app = new Hono();

// POST /api/blurb/analyze — Detect 3 strongest signals
const analyzeSchema = z.object({
  companyName: z.string().min(1),
  description: z.string().min(20, 'Please provide at least a few sentences about your startup'),
});

app.post('/analyze', async (c) => {
  const body = await c.req.json();
  const parsed = analyzeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  try {
    const result = await analyzeSignals(parsed.data.companyName, parsed.data.description);
    return c.json({ signals: result.signals, sector: result.sector });
  } catch (err) {
    console.error('Failed to analyze signals:', err);
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to analyze description',
    }, 500);
  }
});

// POST /api/blurb/match-count — Count matching investors for a sector
const matchCountSchema = z.object({
  sector: z.string().min(1),
});

app.post('/match-count', async (c) => {
  const body = await c.req.json();
  const parsed = matchCountSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  try {
    const { sector } = parsed.data;
    const now = new Date().toISOString();

    // Find the sector category by name (case-insensitive fuzzy match)
    const sectorCategory = db.select({ id: investorCategories.id, name: investorCategories.name })
      .from(investorCategories)
      .where(and(
        eq(investorCategories.type, 'sector'),
        sql`LOWER(${investorCategories.name}) LIKE ${'%' + sector.toLowerCase() + '%'}`,
      ))
      .limit(1)
      .all();

    // Find generalist category
    const generalistCategory = db.select({ id: investorCategories.id })
      .from(investorCategories)
      .where(sql`LOWER(${investorCategories.name}) = 'generalist'`)
      .limit(1)
      .all();

    const sectorId = sectorCategory[0]?.id;
    const generalistId = generalistCategory[0]?.id;

    // Get all active, non-paused investors
    const activeInvestors = db.select({ id: investors.id })
      .from(investors)
      .where(and(
        eq(investors.active, true),
        or(
          sql`${investors.pausedUntil} IS NULL`,
          sql`${investors.pausedUntil} < ${now}`,
        ),
      ))
      .all();

    const activeIds = activeInvestors.map(i => i.id);
    if (activeIds.length === 0) {
      return c.json({ investorCount: 0, sector: sectorCategory[0]?.name || sector });
    }

    // Get investors with the sector category assigned
    const sectorInvestorIds = new Set<number>();
    if (sectorId) {
      const rows = db.select({ investorId: investorCategoryAssignments.investorId })
        .from(investorCategoryAssignments)
        .where(eq(investorCategoryAssignments.categoryId, sectorId))
        .all();
      rows.forEach(r => sectorInvestorIds.add(r.investorId));
    }

    // Get generalist investors
    const generalistInvestorIds = new Set<number>();
    if (generalistId) {
      const rows = db.select({ investorId: investorCategoryAssignments.investorId })
        .from(investorCategoryAssignments)
        .where(eq(investorCategoryAssignments.categoryId, generalistId))
        .all();
      rows.forEach(r => generalistInvestorIds.add(r.investorId));
    }

    // Get investors with any sector category (to find those with none)
    const allSectorCategoryIds = db.select({ id: investorCategories.id })
      .from(investorCategories)
      .where(eq(investorCategories.type, 'sector'))
      .all()
      .map(r => r.id);

    const investorsWithAnySector = new Set<number>();
    if (allSectorCategoryIds.length > 0) {
      const rows = db.select({ investorId: investorCategoryAssignments.investorId })
        .from(investorCategoryAssignments)
        .where(inArray(investorCategoryAssignments.categoryId, allSectorCategoryIds))
        .all();
      rows.forEach(r => investorsWithAnySector.add(r.investorId));
    }

    // Get investors who exclude this sector
    const excludedInvestorIds = new Set<number>();
    if (sectorId) {
      const rows = db.select({ investorId: investorCategoryExclusions.investorId })
        .from(investorCategoryExclusions)
        .where(eq(investorCategoryExclusions.categoryId, sectorId))
        .all();
      rows.forEach(r => excludedInvestorIds.add(r.investorId));
    }

    // Count: active investors who (have sector OR are generalist OR have no sector categories) AND don't exclude
    const matchingInvestorIds = activeIds.filter(id =>
      (sectorInvestorIds.has(id) || generalistInvestorIds.has(id) || !investorsWithAnySector.has(id))
      && !excludedInvestorIds.has(id)
    );

    // Count distinct nodes connected to matching investors
    let nodeCount = 0;
    if (matchingInvestorIds.length > 0) {
      const nodeRows = db.select({ nodeId: nodeInvestorConnections.nodeId })
        .from(nodeInvestorConnections)
        .where(inArray(nodeInvestorConnections.investorId, matchingInvestorIds))
        .all();
      const uniqueNodes = new Set(nodeRows.map(r => r.nodeId));
      nodeCount = uniqueNodes.size;
    }

    return c.json({
      investorCount: matchingInvestorIds.length,
      nodeCount,
      sector: sectorCategory[0]?.name || sector,
    });
  } catch (err) {
    console.error('Failed to count matching investors:', err);
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to count investors',
    }, 500);
  }
});

// POST /api/blurb/generate — Generate blurb from signals + answers
const generateSchema = z.object({
  companyName: z.string().min(1),
  description: z.string().min(1),
  signals: z.array(z.object({
    category: z.string(),
    answer: z.string().min(1),
  })).min(1).max(3),
});

app.post('/generate', async (c) => {
  const body = await c.req.json();
  const parsed = generateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  try {
    const result = await generateBlurb(
      parsed.data.companyName,
      parsed.data.description,
      parsed.data.signals,
    );
    return c.json(result);
  } catch (err) {
    console.error('Failed to generate blurb:', err);
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to generate blurb',
    }, 500);
  }
});

// POST /api/blurb/apply — Submit application to MatCap
const applySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  companyName: z.string().min(1),
  description: z.string().min(1),
  signals: z.array(z.object({
    category: z.string(),
    detected: z.string().optional(),
    followUpQuestion: z.string().optional(),
    answer: z.string(),
  })),
  blurb: z.string().min(1),
  oneLiner: z.string().min(1),
});

app.post('/apply', async (c) => {
  const body = await c.req.json();
  const parsed = applySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const { name, email, companyName, description, signals, blurb, oneLiner } = parsed.data;
  const now = new Date().toISOString();

  try {
    // Split name into first/last
    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || null;

    // Store conversation history as the raw inputs + follow-ups
    const conversationHistory = JSON.stringify({
      source: 'blurb_builder',
      description,
      signals: signals.map(s => ({
        category: s.category,
        detected: s.detected,
        question: s.followUpQuestion,
        answer: s.answer,
      })),
    });

    const [lead] = await db.insert(founderLeads).values({
      firstName,
      lastName,
      email,
      companyName,
      companyDescription: description,
      investorBlurb: blurb,
      oneLiner,
      conversationHistory,
      source: 'blurb_builder',
      signalCategories: JSON.stringify(signals.map(s => ({
        category: s.category,
        detected: s.detected,
        answer: s.answer,
      }))),
      status: 'completed',
      createdAt: now,
      completedAt: now,
    }).returning();

    // Send admin notification email
    const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
    const signalList = signals.map(s => `- ${s.category}: ${s.answer.substring(0, 100)}`).join('\n');

    await sendEmail({
      to: adminEmail,
      subject: `New Blurb Builder Application: ${companyName}`,
      html: `
        <h2>New Blurb Builder Application</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Company:</strong> ${companyName}</p>
        <h3>One-Liner</h3>
        <p>${oneLiner}</p>
        <h3>Blurb</h3>
        <p>${blurb}</p>
        <h3>Signals</h3>
        <ul>${signals.map(s => `<li><strong>${s.category}:</strong> ${s.answer}</li>`).join('')}</ul>
        <p><a href="https://matcap.vc/admin">View in Admin</a></p>
      `,
      text: `New Blurb Builder Application\n\nName: ${name}\nEmail: ${email}\nCompany: ${companyName}\n\nOne-Liner: ${oneLiner}\n\nBlurb:\n${blurb}\n\nSignals:\n${signalList}`,
    });

    return c.json({
      success: true,
      leadId: lead.id,
    });
  } catch (err) {
    console.error('Failed to submit application:', err);
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to submit application',
    }, 500);
  }
});

// POST /api/blurb/signup — Simple founder application (no blurb required)
const signupSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  companyName: z.string().min(1),
  companyUrl: z.string().optional(),
  description: z.string().min(1),
});

app.post('/signup', async (c) => {
  const body = await c.req.json();
  const parsed = signupSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const { firstName, lastName, email, companyName, companyUrl, description } = parsed.data;
  const now = new Date().toISOString();

  try {
    const [lead] = await db.insert(founderLeads).values({
      firstName,
      lastName,
      email,
      companyName,
      companyDescription: description,
      conversationHistory: JSON.stringify({ source: 'signup_form', companyUrl }),
      source: 'signup_form',
      status: 'completed',
      createdAt: now,
      completedAt: now,
    }).returning();

    // Send admin notification email
    const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
    await sendEmail({
      to: adminEmail,
      subject: `New Founder Application: ${companyName}`,
      html: `
        <h2>New Founder Application</h2>
        <p><strong>Name:</strong> ${firstName} ${lastName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Company:</strong> ${companyName}</p>
        ${companyUrl ? `<p><strong>Website:</strong> ${companyUrl}</p>` : ''}
        <h3>Description</h3>
        <p>${description}</p>
        <p><a href="https://matcap.vc/admin">View in Admin</a></p>
      `,
      text: `New Founder Application\n\nName: ${firstName} ${lastName}\nEmail: ${email}\nCompany: ${companyName}\n${companyUrl ? `Website: ${companyUrl}\n` : ''}\nDescription:\n${description}`,
    });

    return c.json({ success: true, leadId: lead.id });
  } catch (err) {
    console.error('Failed to submit signup:', err);
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to submit application',
    }, 500);
  }
});

export default app;
