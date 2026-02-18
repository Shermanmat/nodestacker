import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, founderNodeRelationships, nodeInvestorConnections } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

// Founder-Node Relationships

// List all founder-node relationships
app.get('/founder-node', async (c) => {
  const relationships = await db.query.founderNodeRelationships.findMany({
    with: {
      founder: true,
      node: true,
    },
  });
  return c.json(relationships);
});

// Get specific relationship
app.get('/founder-node/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const relationship = await db.query.founderNodeRelationships.findFirst({
    where: eq(founderNodeRelationships.id, id),
    with: {
      founder: true,
      node: true,
    },
  });

  if (!relationship) {
    return c.json({ error: 'Relationship not found' }, 404);
  }
  return c.json(relationship);
});

// Update founder-node relationship
app.put('/founder-node/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    relationshipStrength: z.enum(['strong', 'medium', 'weak']).optional(),
    howConnected: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const result = await db.update(founderNodeRelationships)
    .set(parsed.data)
    .where(eq(founderNodeRelationships.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Relationship not found' }, 404);
  }
  return c.json(result[0]);
});

// Delete founder-node relationship
app.delete('/founder-node/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const result = await db.delete(founderNodeRelationships)
    .where(eq(founderNodeRelationships.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Relationship not found' }, 404);
  }
  return c.json({ success: true });
});

// Node-Investor Connections

// List all node-investor connections
app.get('/node-investor', async (c) => {
  const connections = await db.query.nodeInvestorConnections.findMany({
    with: {
      node: true,
      investor: true,
    },
  });
  return c.json(connections);
});

// Get specific connection
app.get('/node-investor/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const connection = await db.query.nodeInvestorConnections.findFirst({
    where: eq(nodeInvestorConnections.id, id),
    with: {
      node: true,
      investor: true,
    },
  });

  if (!connection) {
    return c.json({ error: 'Connection not found' }, 404);
  }
  return c.json(connection);
});

// Update node-investor connection
app.put('/node-investor/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    connectionStrength: z.enum(['strong', 'medium', 'weak']).optional(),
    validated: z.boolean().optional(),
    lastIntroDate: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const result = await db.update(nodeInvestorConnections)
    .set(parsed.data)
    .where(eq(nodeInvestorConnections.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Connection not found' }, 404);
  }
  return c.json(result[0]);
});

// Delete node-investor connection
app.delete('/node-investor/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const result = await db.delete(nodeInvestorConnections)
    .where(eq(nodeInvestorConnections.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Connection not found' }, 404);
  }
  return c.json({ success: true });
});

// Bulk create connections
app.post('/node-investor/bulk', async (c) => {
  const body = await c.req.json();

  const schema = z.object({
    connections: z.array(z.object({
      nodeId: z.number(),
      investorId: z.number(),
      connectionStrength: z.enum(['strong', 'medium', 'weak']).optional(),
      addedBy: z.enum(['platform', 'admin', 'founder']).optional(),
      validated: z.boolean().optional(),
    })),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const values = parsed.data.connections.map(conn => ({
    ...conn,
    connectionStrength: conn.connectionStrength || 'medium',
    addedBy: conn.addedBy || 'admin',
    validated: conn.validated || false,
    createdAt: now,
  }));

  const result = await db.insert(nodeInvestorConnections).values(values).returning();
  return c.json(result, 201);
});

export default app;
