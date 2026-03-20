/**
 * Blurb Builder API — AI-powered startup pitch tool
 * Public endpoints (no auth required)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { db, founderLeads } from '../db/index.js';
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
    const signals = await analyzeSignals(parsed.data.companyName, parsed.data.description);
    return c.json({ signals });
  } catch (err) {
    console.error('Failed to analyze signals:', err);
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to analyze description',
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

export default app;
