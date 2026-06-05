/**
 * MCP pipeline tests — tenancy isolation (the most important), field/enum rules,
 * idempotency, and token lifecycle. Runs against a throwaway SQLite DB so it
 * never touches dev/prod data.
 *
 * Run:  npm run test:mcp
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const TMP_DB = path.join(process.cwd(), `.tmp-mcp-test-${Date.now()}.db`);

// These are populated in before() after we've pointed DATABASE_PATH at the temp DB.
let db: any, founders: any, nodes: any, investors: any, introRequests: any;
let dao: typeof import('../src/services/pipeline-dao.js');
let tokens: typeof import('../src/services/mcp-tokens.js');
let A = 0, B = 0;             // two founders
let introIdA = '';           // a matcap_intro composite id owned by A

before(async () => {
  // Build the schema in the throwaway DB by copying DDL (tables + indexes, no
  // data) from the already-migrated dev DB, then point the app at it BEFORE import.
  const srcPath = process.env.DATABASE_PATH || 'nodestacker.db';
  const src = new Database(srcPath, { readonly: true });
  const ddl = src.prepare(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
    "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
  ).all() as Array<{ sql: string }>;
  src.close();
  const dst = new Database(TMP_DB);
  for (const row of ddl) { try { dst.exec(row.sql); } catch { /* skip already-applied */ } }
  dst.close();
  process.env.DATABASE_PATH = TMP_DB;

  const dbMod = await import('../src/db/index.js');
  db = dbMod.db; founders = dbMod.founders; nodes = dbMod.nodes;
  investors = dbMod.investors; introRequests = dbMod.introRequests;
  dao = await import('../src/services/pipeline-dao.js');
  tokens = await import('../src/services/mcp-tokens.js');

  const now = new Date().toISOString();
  const [fa] = await db.insert(founders).values({ name: 'Founder A', email: `a-${Date.now()}@t.co`, companyName: 'ACo', companyStage: 'seed', createdAt: now }).returning();
  const [fb] = await db.insert(founders).values({ name: 'Founder B', email: `b-${Date.now()}@t.co`, companyName: 'BCo', companyStage: 'seed', createdAt: now }).returning();
  A = fa.id; B = fb.id;

  // Seed a MatCap intro for A (needs a node + investor).
  const [node] = await db.insert(nodes).values({ name: 'Node', email: `n-${Date.now()}@t.co`, createdAt: now }).returning();
  const [inv] = await db.insert(investors).values({ name: 'Jane VC', firm: 'Acme', createdAt: now }).returning();
  const [intro] = await db.insert(introRequests).values({ founderId: A, nodeId: node.id, investorId: inv.id, status: 'introduced', createdAt: now, updatedAt: now }).returning();
  introIdA = `matcap_intro:${intro.id}`;
});

after(() => {
  for (const f of [TMP_DB, `${TMP_DB}-shm`, `${TMP_DB}-wal`]) if (existsSync(f)) rmSync(f);
});

// ── The most important test: a founder cannot read or write another's data ────
test('tenancy isolation — Founder B cannot touch Founder A rows', async () => {
  const aRec = await dao.createInvestor(A, { name: 'A-only Capital', firm: 'A' });
  // B cannot see it in their list
  const bList = await dao.listInvestors(B);
  assert.equal(bList.items.find(i => i.id === aRec.id), undefined, 'B should not see A row in list');

  // Every read/write against A's rows, as B, must be denied.
  for (const target of [aRec.id, introIdA]) {
    await assert.rejects(() => dao.getInvestor(B, target), /NOT_FOUND|No pipeline item/);
    await assert.rejects(() => dao.updateInvestor(B, target, { notes: 'hax' }), /NOT_FOUND|No pipeline item/);
    await assert.rejects(() => dao.logTouch(B, target, { interactionType: 'note', content: 'x' }), /NOT_FOUND|No pipeline item/);
  }
  await assert.rejects(() => dao.archiveInvestor(B, aRec.id), /NOT_FOUND|No pipeline item/);

  // And A can still operate on their own row.
  const got = await dao.getInvestor(A, aRec.id);
  assert.equal(got.investorName, 'A-only Capital');
});

test('enum validation is enforced server-side', async () => {
  await assert.rejects(() => dao.createInvestor(A, { name: 'X', source: 'bogus' as any }), /INVALID_ENUM|Invalid source/);
  await assert.rejects(() => dao.createInvestor(A, { name: 'X', status: 'nope' as any }), /INVALID_ENUM|Invalid status/);
  await assert.rejects(() => dao.createInvestor(A, { name: '' }), /name is required|VALIDATION/);
});

test('matcap_intro: founder may edit only their CRM fields, never status/archive', async () => {
  // Allowed: notes maps to founder-owned notes.
  const updated = await dao.updateInvestor(A, introIdA, { notes: 'Met at demo day' });
  assert.equal(updated.notes, 'Met at demo day');
  assert.equal(updated.status, 'introduced', 'status unchanged');

  // Forbidden: status / name on a matcap intro.
  await assert.rejects(() => dao.updateInvestor(A, introIdA, { status: 'passed' as any }), (e: any) => e.code === 'FORBIDDEN_FIELD');
  await assert.rejects(() => dao.updateInvestor(A, introIdA, { name: 'Renamed' }), (e: any) => e.code === 'FORBIDDEN_FIELD');
  // Forbidden: archiving a matcap intro.
  await assert.rejects(() => dao.archiveInvestor(A, introIdA), (e: any) => e.code === 'NOT_ARCHIVABLE');
});

test('self_record: full CRUD incl. archive (soft delete)', async () => {
  const rec = await dao.createInvestor(A, { name: 'Sequoia', firm: 'Sequoia', status: 'self_outreach' });
  const upd = await dao.updateInvestor(A, rec.id, { status: 'first_meeting_complete', checkSize: '$1M' });
  assert.equal(upd.status, 'first_meeting_complete');
  assert.equal(upd.checkSize, '$1M');

  await dao.archiveInvestor(A, rec.id);
  const visible = await dao.listInvestors(A);
  assert.equal(visible.items.find(i => i.id === rec.id), undefined, 'archived row hidden from default list');
  const withArchived = await dao.listInvestors(A, { includeArchived: true });
  assert.ok(withArchived.items.find(i => i.id === rec.id), 'archived row visible with includeArchived');
});

test('bulk_upsert_investors is idempotent on name+firm', async () => {
  const items = [{ name: 'Benchmark', firm: 'Benchmark' }, { name: 'a16z', firm: 'Andreessen' }];
  const first = await dao.bulkUpsertInvestors(A, items);
  assert.equal(first.created, 2);
  const second = await dao.bulkUpsertInvestors(A, items);   // same input again
  assert.equal(second.created, 0, 'no new rows on re-run');
  assert.equal(second.updated, 2, 'existing rows updated instead');

  const list = await dao.listInvestors(A, { search: 'Benchmark', limit: 1000 });
  assert.equal(list.items.filter(i => i.investorName === 'Benchmark').length, 1, 'exactly one Benchmark');
});

test('token lifecycle — verify, scope, revoke, expiry', async () => {
  const { token, record } = await tokens.mintToken(A, { name: 'test' });
  assert.equal(await tokens.verifyToken(token), A, 'valid token resolves to its founder');
  assert.equal(await tokens.verifyToken('mcp_deadbeef'), null, 'unknown token rejected');

  // A founder cannot revoke another founder's token.
  assert.equal(await tokens.revokeToken(B, record.id), false, 'B cannot revoke A token');
  assert.equal(await tokens.verifyToken(token), A, 'still valid after failed cross-revoke');

  // Owner revokes → token dead.
  assert.equal(await tokens.revokeToken(A, record.id), true);
  assert.equal(await tokens.verifyToken(token), null, 'revoked token rejected');

  // Expired token rejected (write an already-expired row directly).
  const { mcpTokens } = await import('../src/db/index.js');
  const past = new Date(Date.now() - 1000).toISOString();
  const { createHash } = await import('node:crypto');
  const raw = 'mcp_expiredtokentest';
  await db.insert(mcpTokens).values({
    founderId: A, tokenHash: createHash('sha256').update(raw).digest('hex'),
    tokenPrefix: raw.slice(0, 12), createdAt: new Date().toISOString(), expiresAt: past,
  });
  assert.equal(await tokens.verifyToken(raw), null, 'expired token rejected');
});
