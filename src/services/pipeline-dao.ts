/**
 * Pipeline data-access layer — the SINGLE tenancy chokepoint for a founder's
 * investor pipeline. This is our app-layer equivalent of Postgres RLS: there is
 * no code path to pipeline data that doesn't go through here, and every read and
 * write is scoped to the `founderId` passed in. A founder can never address
 * another founder's rows — ownership is enforced in the WHERE clause of every
 * query, and on every mutation the target row is confirmed to belong to the
 * caller before it's touched.
 *
 * The pipeline is a UNION of two row kinds, with different permissions:
 *   - 'matcap_intro'  (intro_requests)         → founder may edit ONLY their own
 *     CRM fields (nextAction*, checkSize, notes); status/investor are admin-owned
 *     and cannot be changed here. Not founder-creatable or archivable.
 *   - 'self_record'   (founder_investor_records) → founder owns it fully: create,
 *     edit any field, archive (soft delete).
 *
 * Items are addressed by a composite id "<kind>:<numericId>" (e.g. "self_record:42")
 * so the two tables' autoincrement ids never collide in the MCP surface.
 */

import { and, eq, isNull, desc } from 'drizzle-orm';
import {
  db,
  introRequests,
  founderInvestorRecords,
  investorInteractions,
} from '../db/index.js';

// ── Allowed values (enforced server-side; never trusted from the caller) ──────
export const SELF_RECORD_SOURCES = ['self_added', 'cold_inbound'] as const;
export const SELF_RECORD_STATUSES = [
  'self_outreach', 'first_meeting_complete', 'follow_up_questions', 'passed', 'invested',
] as const;
export const INTERACTION_TYPES = ['meeting', 'email', 'call', 'note', 'intro_sent'] as const;

// On a matcap_intro, only these logical fields are founder-editable. They map to
// the founder_* columns on intro_requests.
const MATCAP_EDITABLE = ['nextActionText', 'nextActionDate', 'checkSize', 'notes'] as const;
const MATCAP_COLUMN: Record<(typeof MATCAP_EDITABLE)[number], string> = {
  nextActionText: 'founderNextActionText',
  nextActionDate: 'founderNextActionDate',
  checkSize: 'founderCheckSize',
  notes: 'founderOwnedNotes',
};

export type Kind = 'matcap_intro' | 'self_record';

export interface PipelineItem {
  id: string;                 // composite "<kind>:<id>"
  kind: Kind;
  investorName: string | null;
  firm: string | null;
  role: string | null;
  email: string | null;
  geography: string | null;
  source: string;            // 'matcap' | 'self_added' | 'cold_inbound'
  status: string;
  nextActionText: string | null;
  nextActionDate: string | null;
  checkSize: string | null;
  notes: string | null;
  lastTouchAt: string | null;
  nodeName: string | null;
  editableFields: string[];  // which fields the founder may change on this item
}

// ── Errors — carry a machine code + HTTP status so the API/MCP layer can map
//    them to clear, non-leaky messages. ────────────────────────────────────────
export type PipelineErrorCode =
  | 'NOT_FOUND' | 'INVALID_ID' | 'FORBIDDEN_FIELD' | 'INVALID_ENUM'
  | 'NOT_ARCHIVABLE' | 'VALIDATION';

export class PipelineError extends Error {
  constructor(public code: PipelineErrorCode, message: string, public httpStatus = 400) {
    super(message);
    this.name = 'PipelineError';
  }
}

// ── Composite id helpers ─────────────────────────────────────────────────────
function makeId(kind: Kind, id: number): string {
  return `${kind}:${id}`;
}
function parseId(composite: string): { kind: Kind; id: number } {
  const [kind, idStr] = (composite ?? '').split(':');
  const id = Number(idStr);
  if ((kind !== 'matcap_intro' && kind !== 'self_record') || !Number.isInteger(id) || id <= 0) {
    throw new PipelineError('INVALID_ID', `Invalid pipeline id "${composite}". Expected "matcap_intro:<n>" or "self_record:<n>".`);
  }
  return { kind, id };
}

// ── Mappers (DB row → PipelineItem) ──────────────────────────────────────────
function introToItem(ir: any): PipelineItem {
  return {
    id: makeId('matcap_intro', ir.id),
    kind: 'matcap_intro',
    investorName: ir.investor?.name ?? null,
    firm: ir.investor?.firm ?? null,
    role: ir.investor?.role ?? null,
    email: ir.investor?.email ?? null,
    geography: ir.investor?.geography ?? null,
    source: 'matcap',
    status: ir.status,
    nextActionText: ir.founderNextActionText ?? null,
    nextActionDate: ir.founderNextActionDate ?? null,
    checkSize: ir.founderCheckSize ?? null,
    notes: ir.founderOwnedNotes ?? null,
    lastTouchAt: ir.updatedAt ?? null,
    nodeName: ir.node?.name ?? null,
    editableFields: [...MATCAP_EDITABLE],
  };
}
function recordToItem(r: any): PipelineItem {
  return {
    id: makeId('self_record', r.id),
    kind: 'self_record',
    investorName: r.name,
    firm: r.firm ?? null,
    role: r.role ?? null,
    email: r.email ?? null,
    geography: r.geography ?? null,
    source: r.source,
    status: r.status,
    nextActionText: r.nextActionText ?? null,
    nextActionDate: r.nextActionDate ?? null,
    checkSize: r.checkSize ?? null,
    notes: r.notes ?? null,
    lastTouchAt: r.updatedAt ?? null,
    nodeName: null,
    editableFields: ['name', 'firm', 'role', 'email', 'geography', 'source', 'status', 'nextActionText', 'nextActionDate', 'checkSize', 'notes'],
  };
}

function assertEnum<T extends readonly string[]>(value: string | undefined, allowed: T, field: string) {
  if (value !== undefined && !allowed.includes(value as any)) {
    throw new PipelineError('INVALID_ENUM', `Invalid ${field} "${value}". Allowed: ${allowed.join(', ')}.`);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────
export interface ListFilters {
  status?: string;
  source?: string;        // 'matcap' | 'self_added' | 'cold_inbound'
  kind?: Kind;
  search?: string;        // matches investor name or firm (case-insensitive)
  needsAttention?: boolean;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export async function listInvestors(founderId: number, filters: ListFilters = {}): Promise<{ items: PipelineItem[]; total: number }> {
  const intros = await db.query.introRequests.findMany({
    where: eq(introRequests.founderId, founderId),
    with: { investor: true, node: true },
    orderBy: desc(introRequests.updatedAt),
  });
  const recordWhere = filters.includeArchived
    ? eq(founderInvestorRecords.founderId, founderId)
    : and(eq(founderInvestorRecords.founderId, founderId), isNull(founderInvestorRecords.archivedAt));
  const records = await db.query.founderInvestorRecords.findMany({
    where: recordWhere,
    orderBy: desc(founderInvestorRecords.updatedAt),
  });

  let items: PipelineItem[] = [...intros.map(introToItem), ...records.map(recordToItem)];

  // Filters (applied in-memory; a founder's pipeline is small).
  const today = new Date().toISOString().split('T')[0];
  if (filters.kind) items = items.filter(i => i.kind === filters.kind);
  if (filters.status) items = items.filter(i => i.status === filters.status);
  if (filters.source) items = items.filter(i => i.source === filters.source);
  if (filters.needsAttention) {
    items = items.filter(i =>
      (i.nextActionDate && i.nextActionDate <= today) || i.status === 'follow_up_questions');
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    items = items.filter(i =>
      (i.investorName ?? '').toLowerCase().includes(q) || (i.firm ?? '').toLowerCase().includes(q));
  }

  items.sort((a, b) => (b.lastTouchAt ?? '').localeCompare(a.lastTouchAt ?? ''));

  const total = items.length;
  const offset = Math.max(0, filters.offset ?? 0);
  const limit = filters.limit && filters.limit > 0 ? filters.limit : 100;
  return { items: items.slice(offset, offset + limit), total };
}

export async function getInvestor(founderId: number, compositeId: string): Promise<PipelineItem> {
  const { kind, id } = parseId(compositeId);
  if (kind === 'matcap_intro') {
    const ir = await db.query.introRequests.findFirst({
      where: and(eq(introRequests.id, id), eq(introRequests.founderId, founderId)),
      with: { investor: true, node: true },
    });
    if (!ir) throw new PipelineError('NOT_FOUND', `No pipeline item ${compositeId}.`, 404);
    return introToItem(ir);
  }
  const r = await db.query.founderInvestorRecords.findFirst({
    where: and(eq(founderInvestorRecords.id, id), eq(founderInvestorRecords.founderId, founderId)),
  });
  if (!r) throw new PipelineError('NOT_FOUND', `No pipeline item ${compositeId}.`, 404);
  return recordToItem(r);
}

// ── Writes ───────────────────────────────────────────────────────────────────
export interface CreateInput {
  name: string;
  firm?: string | null;
  role?: string | null;
  email?: string | null;
  geography?: string | null;
  source?: string;
  status?: string;
  nextActionText?: string | null;
  nextActionDate?: string | null;
  checkSize?: string | null;
  notes?: string | null;
}

/** Create a self-managed pipeline record (you cannot create a MatCap intro). */
export async function createInvestor(founderId: number, input: CreateInput): Promise<PipelineItem> {
  if (!input.name || !input.name.trim()) {
    throw new PipelineError('VALIDATION', 'name is required.');
  }
  assertEnum(input.source, SELF_RECORD_SOURCES, 'source');
  assertEnum(input.status, SELF_RECORD_STATUSES, 'status');

  const now = new Date().toISOString();
  const [created] = await db.insert(founderInvestorRecords).values({
    founderId,
    name: input.name.trim(),
    firm: input.firm ?? null,
    role: input.role ?? null,
    email: input.email ?? null,
    geography: input.geography ?? null,
    source: input.source ?? 'self_added',
    status: input.status ?? 'self_outreach',
    nextActionText: input.nextActionText ?? null,
    nextActionDate: input.nextActionDate ?? null,
    checkSize: input.checkSize ?? null,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return recordToItem(created);
}

export type UpdateInput = Partial<CreateInput>;

/**
 * Update a pipeline item. Kind-aware:
 *  - self_record: any field may change (enums validated).
 *  - matcap_intro: ONLY nextActionText/nextActionDate/checkSize/notes. Any other
 *    field (e.g. status, name) is rejected with FORBIDDEN_FIELD.
 * Ownership is enforced before any write.
 */
export async function updateInvestor(founderId: number, compositeId: string, patch: UpdateInput): Promise<PipelineItem> {
  const { kind, id } = parseId(compositeId);
  const keys = Object.keys(patch).filter(k => (patch as any)[k] !== undefined);
  if (keys.length === 0) throw new PipelineError('VALIDATION', 'No fields to update.');

  if (kind === 'matcap_intro') {
    const ir = await db.query.introRequests.findFirst({
      where: and(eq(introRequests.id, id), eq(introRequests.founderId, founderId)),
    });
    if (!ir) throw new PipelineError('NOT_FOUND', `No pipeline item ${compositeId}.`, 404);

    const forbidden = keys.filter(k => !(MATCAP_EDITABLE as readonly string[]).includes(k));
    if (forbidden.length) {
      throw new PipelineError('FORBIDDEN_FIELD',
        `On a MatCap intro you can only edit ${MATCAP_EDITABLE.join(', ')}. Not allowed: ${forbidden.join(', ')}. (Status and investor details are managed by MatCap.)`,
        403);
    }
    const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
    for (const k of keys) updates[MATCAP_COLUMN[k as (typeof MATCAP_EDITABLE)[number]]] = (patch as any)[k];
    await db.update(introRequests).set(updates).where(and(eq(introRequests.id, id), eq(introRequests.founderId, founderId)));
    return getInvestor(founderId, compositeId);
  }

  // self_record — full edit, enums validated.
  const r = await db.query.founderInvestorRecords.findFirst({
    where: and(eq(founderInvestorRecords.id, id), eq(founderInvestorRecords.founderId, founderId)),
  });
  if (!r) throw new PipelineError('NOT_FOUND', `No pipeline item ${compositeId}.`, 404);
  assertEnum(patch.source, SELF_RECORD_SOURCES, 'source');
  assertEnum(patch.status, SELF_RECORD_STATUSES, 'status');

  const allowed = new Set(['name', 'firm', 'role', 'email', 'geography', 'source', 'status', 'nextActionText', 'nextActionDate', 'checkSize', 'notes']);
  const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
  for (const k of keys) {
    if (!allowed.has(k)) throw new PipelineError('FORBIDDEN_FIELD', `Field "${k}" cannot be set.`);
    updates[k] = (patch as any)[k];
  }
  await db.update(founderInvestorRecords).set(updates).where(and(eq(founderInvestorRecords.id, id), eq(founderInvestorRecords.founderId, founderId)));
  return getInvestor(founderId, compositeId);
}

/** Soft-delete (archive) a self_record. MatCap intros are not archivable here. */
export async function archiveInvestor(founderId: number, compositeId: string): Promise<{ id: string; archived: true }> {
  const { kind, id } = parseId(compositeId);
  if (kind === 'matcap_intro') {
    throw new PipelineError('NOT_ARCHIVABLE', 'MatCap intros are managed by MatCap and cannot be archived here.', 403);
  }
  const [row] = await db.update(founderInvestorRecords)
    .set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(and(eq(founderInvestorRecords.id, id), eq(founderInvestorRecords.founderId, founderId)))
    .returning();
  if (!row) throw new PipelineError('NOT_FOUND', `No pipeline item ${compositeId}.`, 404);
  return { id: compositeId, archived: true };
}

export interface TouchInput {
  interactionType: string;       // one of INTERACTION_TYPES
  occurredAt?: string;           // ISO; defaults to now
  content?: string | null;
  advanceStatusTo?: string;      // self_record only — optional status change
}

/** Record an interaction (last-touch). Optionally advance a self_record's status. */
export async function logTouch(founderId: number, compositeId: string, input: TouchInput): Promise<{ interactionId: number; item: PipelineItem }> {
  assertEnum(input.interactionType, INTERACTION_TYPES, 'interactionType');
  const { kind, id } = parseId(compositeId);
  const now = new Date().toISOString();

  if (kind === 'matcap_intro') {
    const ir = await db.query.introRequests.findFirst({
      where: and(eq(introRequests.id, id), eq(introRequests.founderId, founderId)),
    });
    if (!ir) throw new PipelineError('NOT_FOUND', `No pipeline item ${compositeId}.`, 404);
    if (input.advanceStatusTo !== undefined) {
      throw new PipelineError('FORBIDDEN_FIELD', 'Cannot change status on a MatCap intro.', 403);
    }
    const [ix] = await db.insert(investorInteractions).values({
      founderId, investorId: ir.investorId, interactionType: input.interactionType,
      occurredAt: input.occurredAt ?? now, content: input.content ?? null, createdBy: 'founder', createdAt: now,
    }).returning();
    await db.update(introRequests).set({ updatedAt: now }).where(and(eq(introRequests.id, id), eq(introRequests.founderId, founderId)));
    return { interactionId: ix.id, item: await getInvestor(founderId, compositeId) };
  }

  const r = await db.query.founderInvestorRecords.findFirst({
    where: and(eq(founderInvestorRecords.id, id), eq(founderInvestorRecords.founderId, founderId)),
  });
  if (!r) throw new PipelineError('NOT_FOUND', `No pipeline item ${compositeId}.`, 404);
  if (input.advanceStatusTo !== undefined) assertEnum(input.advanceStatusTo, SELF_RECORD_STATUSES, 'advanceStatusTo');

  const [ix] = await db.insert(investorInteractions).values({
    founderId, founderInvestorRecordId: r.id, interactionType: input.interactionType,
    occurredAt: input.occurredAt ?? now, content: input.content ?? null, createdBy: 'founder', createdAt: now,
  }).returning();
  const recUpdate: Record<string, any> = { updatedAt: now };
  if (input.advanceStatusTo !== undefined) recUpdate.status = input.advanceStatusTo;
  await db.update(founderInvestorRecords).set(recUpdate).where(and(eq(founderInvestorRecords.id, r.id), eq(founderInvestorRecords.founderId, founderId)));
  return { interactionId: ix.id, item: await getInvestor(founderId, compositeId) };
}

/**
 * Idempotent bulk upsert of self_records. Natural key = (founderId, lower(name),
 * lower(firm)). Running the same input twice produces no duplicates: an existing
 * (non-archived) match is updated; otherwise a new record is created.
 */
export async function bulkUpsertInvestors(founderId: number, items: CreateInput[]): Promise<{ created: number; updated: number; ids: string[] }> {
  if (!Array.isArray(items) || items.length === 0) throw new PipelineError('VALIDATION', 'items must be a non-empty array.');

  const existing = await db.query.founderInvestorRecords.findMany({
    where: and(eq(founderInvestorRecords.founderId, founderId), isNull(founderInvestorRecords.archivedAt)),
  });
  const keyOf = (name: string, firm?: string | null) => `${(name ?? '').trim().toLowerCase()}|${(firm ?? '').trim().toLowerCase()}`;
  const index = new Map(existing.map(r => [keyOf(r.name, r.firm), r] as const));

  let created = 0, updated = 0;
  const ids: string[] = [];
  const now = new Date().toISOString();

  for (const input of items) {
    if (!input.name || !input.name.trim()) throw new PipelineError('VALIDATION', 'Every item needs a name.');
    assertEnum(input.source, SELF_RECORD_SOURCES, 'source');
    assertEnum(input.status, SELF_RECORD_STATUSES, 'status');

    const match = index.get(keyOf(input.name, input.firm));
    if (match) {
      const updates: Record<string, any> = { updatedAt: now };
      for (const k of ['firm', 'role', 'email', 'geography', 'source', 'status', 'nextActionText', 'nextActionDate', 'checkSize', 'notes'] as const) {
        if ((input as any)[k] !== undefined) updates[k] = (input as any)[k];
      }
      await db.update(founderInvestorRecords).set(updates).where(and(eq(founderInvestorRecords.id, match.id), eq(founderInvestorRecords.founderId, founderId)));
      ids.push(makeId('self_record', match.id));
      updated++;
    } else {
      const [row] = await db.insert(founderInvestorRecords).values({
        founderId,
        name: input.name.trim(),
        firm: input.firm ?? null,
        role: input.role ?? null,
        email: input.email ?? null,
        geography: input.geography ?? null,
        source: input.source ?? 'self_added',
        status: input.status ?? 'self_outreach',
        nextActionText: input.nextActionText ?? null,
        nextActionDate: input.nextActionDate ?? null,
        checkSize: input.checkSize ?? null,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning();
      index.set(keyOf(row.name, row.firm), row); // so duplicate keys within one batch collapse
      ids.push(makeId('self_record', row.id));
      created++;
    }
  }
  return { created, updated, ids };
}

const CLOSED_STATUSES = new Set(['passed', 'invested', 'ignored']);

/** Dashboard counts: total, by status, needs-follow-up, self-added, active, closed. */
export async function getPipelineSummary(founderId: number): Promise<{
  total: number; active: number; needsFollowUp: number; selfAdded: number; closed: number; byStatus: Record<string, number>;
}> {
  const { items } = await listInvestors(founderId, { limit: 100000 });
  const today = new Date().toISOString().split('T')[0];
  const byStatus: Record<string, number> = {};
  let needsFollowUp = 0, selfAdded = 0, closed = 0;
  for (const i of items) {
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    if ((i.nextActionDate && i.nextActionDate <= today) || i.status === 'follow_up_questions') needsFollowUp++;
    if (i.kind === 'self_record') selfAdded++;
    if (CLOSED_STATUSES.has(i.status)) closed++;
  }
  return { total: items.length, active: items.length - closed, needsFollowUp, selfAdded, closed, byStatus };
}
