import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';

import foundersRoutes from './api/founders.js';
import nodesRoutes from './api/nodes.js';
import investorsRoutes from './api/investors.js';
import introRequestsRoutes from './api/intro-requests.js';
import relationshipsRoutes from './api/relationships.js';
import digestRoutes from './api/digest.js';
import authRoutes from './api/auth.js';
import founderPortalRoutes from './api/founder-portal.js';
import investorResearchRoutes from './api/investor-research.js';
import portfolioRoutes from './api/portfolio.js';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('/api/*', cors());

// API Routes
app.route('/api/founders', foundersRoutes);
app.route('/api/nodes', nodesRoutes);
app.route('/api/investors', investorsRoutes);
app.route('/api/investors', investorResearchRoutes);
app.route('/api/intro-requests', introRequestsRoutes);
app.route('/api/relationships', relationshipsRoutes);
app.route('/api/digest', digestRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/portal', founderPortalRoutes);
app.route('/api/portfolio', portfolioRoutes);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Explicit route for founder portal
app.get('/founder', serveStatic({ path: './public/founder.html' }));

// Serve static files from public directory
app.use('/*', serveStatic({ root: './public' }));

// Fallback to index.html for SPA routing (admin)
app.get('*', serveStatic({ path: './public/index.html' }));

const port = parseInt(process.env.PORT || '3000');
console.log(`NodeStacker server running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
