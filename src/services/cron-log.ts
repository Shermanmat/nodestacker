import { eq } from 'drizzle-orm';
import { db, cronRuns } from '../db/index.js';

// Wrap a cron job body so every fire gets a row in cron_runs:
//   - one INSERT on entry (status='running')
//   - one UPDATE on completion with status + finishedAt + result/error
// Lets us answer "did the weekly digest fire last week?" with a single
// query instead of digging through Fly logs / Postmark.
export async function withCronRun<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const [{ id }] = await db.insert(cronRuns)
    .values({ name, startedAt, status: 'running' })
    .returning({ id: cronRuns.id });

  try {
    const result = await fn();
    await db.update(cronRuns).set({
      finishedAt: new Date().toISOString(),
      status: 'success',
      result: safeStringify(result),
    }).where(eq(cronRuns.id, id));
    return result;
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    await db.update(cronRuns).set({
      finishedAt: new Date().toISOString(),
      status: 'error',
      error: msg,
    }).where(eq(cronRuns.id, id));
    throw err;
  }
}

function safeStringify(v: unknown): string | null {
  try { return JSON.stringify(v); } catch { return null; }
}
