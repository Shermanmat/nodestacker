import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, nodes, nodeInvestorConnections, founderNodeRelationships, introRequests } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

const createNodeSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  company: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  geography: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const updateNodeSchema = createNodeSchema.partial();

// List all nodes
app.get('/', async (c) => {
  const allNodes = await db.select().from(nodes);
  return c.json(allNodes);
});

// Get single node with connections
app.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const node = await db.query.nodes.findFirst({
    where: eq(nodes.id, id),
    with: {
      founderRelationships: {
        with: {
          founder: true,
        },
      },
      investorConnections: {
        with: {
          investor: true,
        },
      },
      introRequests: {
        with: {
          founder: true,
          investor: true,
        },
      },
    },
  });

  if (!node) {
    return c.json({ error: 'Node not found' }, 404);
  }
  return c.json(node);
});

// Create node
app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = createNodeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(nodes).values({
    ...parsed.data,
    createdAt: now,
  }).returning();

  return c.json(result[0], 201);
});

// Update node
app.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = updateNodeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const result = await db.update(nodes)
    .set(parsed.data)
    .where(eq(nodes.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Node not found' }, 404);
  }
  return c.json(result[0]);
});

// Delete node (and cascade to related records)
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));

  // First check if node exists
  const node = await db.select().from(nodes).where(eq(nodes.id, id));
  if (node.length === 0) {
    return c.json({ error: 'Node not found' }, 404);
  }

  // Delete related records first (cascade)
  await db.delete(nodeInvestorConnections).where(eq(nodeInvestorConnections.nodeId, id));
  await db.delete(founderNodeRelationships).where(eq(founderNodeRelationships.nodeId, id));
  await db.delete(introRequests).where(eq(introRequests.nodeId, id));

  // Now delete the node
  await db.delete(nodes).where(eq(nodes.id, id));

  return c.json({ success: true });
});

// Get node's investors
app.get('/:id/investors', async (c) => {
  const id = parseInt(c.req.param('id'));
  const connections = await db.query.nodeInvestorConnections.findMany({
    where: eq(nodeInvestorConnections.nodeId, id),
    with: {
      investor: true,
    },
  });
  return c.json(connections);
});

// Add investor connection
app.post('/:id/investors', async (c) => {
  const nodeId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    investorId: z.number(),
    connectionStrength: z.enum(['strong', 'medium', 'weak']).optional(),
    addedBy: z.enum(['platform', 'admin', 'founder']).optional(),
    validated: z.boolean().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(nodeInvestorConnections).values({
    nodeId,
    investorId: parsed.data.investorId,
    connectionStrength: parsed.data.connectionStrength || 'medium',
    addedBy: parsed.data.addedBy || 'admin',
    validated: parsed.data.validated || false,
    createdAt: now,
  }).returning();

  return c.json(result[0], 201);
});

export default app;
