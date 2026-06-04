/**
 * Agent actions ledger — the accountability spine for the AI worker.
 *
 * Two jobs:
 *  1. AUDIT — every agent tick records what it did/proposed here, so there's a
 *     single place to answer "what has the agent been doing, and is it doing
 *     well" (the scorecard reads off this too).
 *  2. APPROVAL GATE — net-new autonomous actions can be recorded as `proposed`
 *     and only take effect once an admin approves them. Approval dispatches to a
 *     registered handler for that action type.
 *
 * Existing surfaces (match_suggestions, Gmail drafts) keep working as-is; this
 * is the meta-log over them, not a replacement. Wire a tick in by calling
 * recordAction() after it acts, or proposeAction() when it wants a human gate.
 */

import { eq, desc, and } from 'drizzle-orm';
import { db, agentActions, type AgentAction } from '../db/index.js';

export type ActionStatus = 'logged' | 'proposed' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface RecordActionInput {
  agent: string;
  actionType: string;
  summary: string;
  reasoning?: string;
  entityType?: string;
  entityId?: number;
  payload?: unknown;        // serialized to JSON
  dryRun?: boolean;
}

function serialize(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

/**
 * Append an after-the-fact ledger entry for something the agent already did.
 * Status defaults to 'logged' (no approval needed — pure audit trail).
 */
export async function recordAction(
  input: RecordActionInput & { status?: Extract<ActionStatus, 'logged' | 'executed' | 'failed'>; result?: unknown }
): Promise<AgentAction> {
  const now = new Date().toISOString();
  const [row] = await db.insert(agentActions).values({
    agent: input.agent,
    actionType: input.actionType,
    summary: input.summary,
    reasoning: input.reasoning ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    payload: serialize(input.payload),
    status: input.status ?? 'logged',
    dryRun: input.dryRun ?? false,
    result: serialize(input.result),
    createdAt: now,
    executedAt: input.status === 'executed' ? now : null,
  }).returning();
  return row;
}

/**
 * Record an action that needs a human decision before it takes effect. The
 * agent must NOT perform the side effect itself — it only describes it here.
 * Execution happens later in decideAction() via the registered handler.
 */
export async function proposeAction(input: RecordActionInput): Promise<AgentAction> {
  const now = new Date().toISOString();
  const [row] = await db.insert(agentActions).values({
    agent: input.agent,
    actionType: input.actionType,
    summary: input.summary,
    reasoning: input.reasoning ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    payload: serialize(input.payload),
    status: 'proposed',
    dryRun: input.dryRun ?? false,
    createdAt: now,
  }).returning();
  return row;
}

// ── Handler registry ────────────────────────────────────────────────────────
// Net-new autonomous actions register an executor keyed by actionType. On
// approval, decideAction() looks up and runs it with the parsed payload. A
// handler returns an arbitrary result object (stored as JSON) or throws.
type ActionHandler = (action: AgentAction, payload: any) => Promise<unknown>;
const handlers = new Map<string, ActionHandler>();

export function registerActionHandler(actionType: string, handler: ActionHandler) {
  handlers.set(actionType, handler);
}

export async function listActions(opts: { status?: ActionStatus; agent?: string; limit?: number } = {}): Promise<AgentAction[]> {
  const conds = [];
  if (opts.status) conds.push(eq(agentActions.status, opts.status));
  if (opts.agent) conds.push(eq(agentActions.agent, opts.agent));
  const where = conds.length ? and(...conds) : undefined;
  return db.select().from(agentActions)
    .where(where as any)
    .orderBy(desc(agentActions.createdAt))
    .limit(opts.limit ?? 100);
}

export async function getAction(id: number): Promise<AgentAction | undefined> {
  const [row] = await db.select().from(agentActions).where(eq(agentActions.id, id));
  return row;
}

/**
 * Approve or reject a proposed action. On approve, if a handler is registered
 * for the actionType, it runs and the row moves to 'executed' (or 'failed').
 * With no handler, approval just marks it 'approved' (a human will act on it).
 * dry-run approvals never execute — they record what would have happened.
 */
export async function decideAction(
  id: number,
  decision: 'approve' | 'reject',
  decidedBy: string,
): Promise<AgentAction> {
  const action = await getAction(id);
  if (!action) throw new Error(`Agent action ${id} not found`);
  if (action.status !== 'proposed') {
    throw new Error(`Agent action ${id} is '${action.status}', not 'proposed'`);
  }

  const now = new Date().toISOString();

  if (decision === 'reject') {
    const [row] = await db.update(agentActions)
      .set({ status: 'rejected', decidedBy, decidedAt: now })
      .where(eq(agentActions.id, id)).returning();
    return row;
  }

  // Approve. Record the decision first.
  await db.update(agentActions)
    .set({ status: 'approved', decidedBy, decidedAt: now })
    .where(eq(agentActions.id, id));

  const handler = handlers.get(action.actionType);
  if (!handler || action.dryRun) {
    // No executor (human will carry it out) or dry-run (never executes).
    const [row] = await db.select().from(agentActions).where(eq(agentActions.id, id));
    return row;
  }

  // Execute via the registered handler.
  const payload = action.payload ? JSON.parse(action.payload) : null;
  try {
    const result = await handler(action, payload);
    const [row] = await db.update(agentActions)
      .set({ status: 'executed', result: serialize(result), executedAt: new Date().toISOString() })
      .where(eq(agentActions.id, id)).returning();
    return row;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [row] = await db.update(agentActions)
      .set({ status: 'failed', result: serialize({ error: message }), executedAt: new Date().toISOString() })
      .where(eq(agentActions.id, id)).returning();
    return row;
  }
}

/**
 * Scorecard seed (Step 3) — coarse counts the admin can glance at to judge the
 * agent: total volume, how much needed approval, approval rate, failure rate.
 */
export async function getScorecard(): Promise<{
  total: number;
  byStatus: Record<string, number>;
  byAgent: Record<string, number>;
  approvalRate: number | null;
}> {
  const rows = await db.select().from(agentActions);
  const byStatus: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byAgent[r.agent] = (byAgent[r.agent] || 0) + 1;
  }
  const decided = (byStatus.approved || 0) + (byStatus.executed || 0) + (byStatus.rejected || 0);
  const accepted = (byStatus.approved || 0) + (byStatus.executed || 0);
  return {
    total: rows.length,
    byStatus,
    byAgent,
    approvalRate: decided > 0 ? Math.round((accepted / decided) * 100) : null,
  };
}
