// Reply classifier: reads investor replies from Gmail, classifies them via
// an LLM, and applies the matching status transition to intro_requests.
//
// Loop:
//   1. Find every intro where replyDetectedAt is set, status is still
//      'intro_request_sent', and replyClassification is null (i.e. detected
//      but not yet classified).
//   2. Fetch the actual latest investor message body from the Gmail thread.
//   3. Call the LLM (reply-llm.ts) to get { class, confidence, reason }.
//   4. Apply the right status transition. For 'yes' we also draft the
//      founder↔investor intro reply in the same thread.
//   5. Persist the classification + snippet for audit.
//
// Nothing is sent. 'yes' creates a Gmail draft; the admin clicks send.

import { eq, and, isNull, sql } from 'drizzle-orm';
import { db, founders, investors, introRequests, agentSettings } from '../db/index.js';
import { getStatus as getGmailStatus, getLatestMessageFromSender, sendThreadReply } from './gmail.js';
import { classifyReply, type ReplyClass } from './reply-llm.js';

// Read the singleton agent_settings row. Falls back to safe defaults if the
// row is missing for some reason.
async function loadAgentSettings(): Promise<{
  autoSendHandoff: boolean;
  autoSendHandoffMinConfidence: number;
  autoSendHandoffMaxReplyChars: number;
}> {
  const row = await db.query.agentSettings.findFirst({ where: eq(agentSettings.id, 1) });
  return {
    autoSendHandoff: row?.autoSendHandoff ?? false,
    autoSendHandoffMinConfidence: row?.autoSendHandoffMinConfidence ? Number(row.autoSendHandoffMinConfidence) : 0.9,
    autoSendHandoffMaxReplyChars: row?.autoSendHandoffMaxReplyChars ?? 400,
  };
}

type RowAction =
  | { action: 'classified'; classification: ReplyClass; confidence: number; reason: string; draftedHandoff?: boolean; autoSentHandoff?: boolean }
  | { action: 'skipped'; detail: string };

export interface ClassifierTickResult {
  checked: number;
  classified: number;
  drafted: number;
  autoSent: number;
  skipped: number;
  rows: Array<{
    introId: number;
    founderName: string;
    investorName: string;
  } & RowAction>;
}

export async function runReplyClassifierTick(): Promise<ClassifierTickResult> {
  const gmail = await getGmailStatus();
  if (!gmail.connected) {
    return { checked: 0, classified: 0, drafted: 0, autoSent: 0, skipped: 0, rows: [] };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { checked: 0, classified: 0, drafted: 0, autoSent: 0, skipped: 0, rows: [] };
  }

  const candidates = await db.select().from(introRequests).where(and(
    eq(introRequests.status, 'intro_request_sent'),
    sql`${introRequests.replyDetectedAt} IS NOT NULL`,
    isNull(introRequests.replyClassification),
    sql`${introRequests.gmailThreadId} IS NOT NULL AND ${introRequests.gmailThreadId} != ''`,
  ));

  const settings = await loadAgentSettings();
  const rows: ClassifierTickResult['rows'] = [];
  let classified = 0;
  let drafted = 0;
  let autoSent = 0;
  let skipped = 0;

  for (const intro of candidates) {
    const [investor, founder] = await Promise.all([
      db.query.investors.findFirst({ where: eq(investors.id, intro.investorId) }),
      db.query.founders.findFirst({ where: eq(founders.id, intro.founderId) }),
    ]);
    if (!investor || !investor.email || !founder || !intro.gmailThreadId) {
      skipped++;
      rows.push({ introId: intro.id, founderName: founder?.name || 'Unknown', investorName: investor?.name || 'Unknown', action: 'skipped', detail: 'missing investor email / founder / thread id' });
      continue;
    }

    // 1. Fetch the reply body
    let msg: { body: string; receivedAt: string | null; messageId: string } | null;
    try {
      msg = await getLatestMessageFromSender(intro.gmailThreadId, investor.email);
    } catch (e: any) {
      skipped++;
      rows.push({ introId: intro.id, founderName: founder.name, investorName: investor.name, action: 'skipped', detail: `gmail fetch failed: ${e.message || e}` });
      continue;
    }
    if (!msg) {
      skipped++;
      rows.push({ introId: intro.id, founderName: founder.name, investorName: investor.name, action: 'skipped', detail: 'no message from investor found in thread' });
      continue;
    }

    // 2. Classify
    let result;
    try {
      result = await classifyReply(msg.body, {
        founderName: founder.name,
        companyName: founder.companyName,
        investorName: investor.name,
        investorFirm: investor.firm ?? null,
      });
    } catch (e: any) {
      skipped++;
      rows.push({ introId: intro.id, founderName: founder.name, investorName: investor.name, action: 'skipped', detail: `classify failed: ${e.message || e}` });
      continue;
    }

    // 3. Persist classification fields + apply status transition
    const now = new Date().toISOString();
    const snippet = msg.body.trim().slice(0, 500);
    const updates: Record<string, unknown> = {
      replyClassification: result.classification,
      replyClassificationAt: now,
      replyClassificationConfidence: String(result.confidence),
      replyBodySnippet: snippet,
      updatedAt: now,
    };

    let draftedHandoff = false;
    let autoSentHandoff = false;

    switch (result.classification) {
      case 'yes': {
        updates.status = 'introduced';
        updates.dateIntroduced = now.split('T')[0];

        // Decide: auto-send the handoff, or just draft it? Auto-send only
        // when ALL of these hold:
        //   1. agent_settings.autoSendHandoff is true (admin kill switch)
        //   2. classifier confidence is at or above the configured floor
        //   3. investor reply was short/clear (no nuance hiding under a "yes")
        //   4. founder has an email so we can Cc them
        const replyShort = msg.body.trim().length <= settings.autoSendHandoffMaxReplyChars;
        const confidenceOk = result.confidence >= settings.autoSendHandoffMinConfidence;
        const canAutoSend =
          settings.autoSendHandoff &&
          confidenceOk &&
          replyShort &&
          !!founder.email;

        try {
          const investorFirst = (investor.name || '').split(/\s+/)[0] || 'there';
          const founderFirst = (founder.name || '').split(/\s+/)[0] || founder.name;
          const blurbLine = founder.blurb ? `\n\n${founder.blurb.trim()}\n` : '';
          const subject = `Re: ${founder.companyName || founder.name}`;
          const handoffBody = `Great, ${investorFirst}.\n\n${founderFirst}, meet ${investorFirst}${investor.firm ? ` (${investor.firm})` : ''}.${blurbLine}\nOver to you both — happy to be helpful from the sidelines.`;
          const sent = await sendThreadReply({
            threadId: intro.gmailThreadId,
            to: investor.email!,
            cc: founder.email || undefined,
            subject,
            body: handoffBody,
            asDraft: !canAutoSend,
          });
          if (canAutoSend) {
            updates.introHandoffSentAt = now;
            updates.introHandoffAutoSent = true;
            updates.introHandoffMessageId = sent.messageId || null;
            autoSentHandoff = true;
            autoSent++;
          } else {
            const draftId = (sent as any).draftId as string | undefined;
            if (draftId) {
              updates.introHandoffDraftId = draftId;
              updates.introHandoffDraftCreatedAt = now;
              draftedHandoff = true;
              drafted++;
            }
          }
        } catch (e: any) {
          // Failure here doesn't block the status transition — admin can
          // write the intro themselves from the Gmail thread.
          console.error('[reply-classifier] handoff send/draft failed:', e);
        }
        break;
      }
      case 'no': {
        updates.status = 'passed';
        updates.datePassed = now.split('T')[0];
        updates.passReason = result.reason || 'pass';
        break;
      }
      case 'not_now': {
        // User's call: this is still a pass, with the reason flagged.
        updates.status = 'passed';
        updates.datePassed = now.split('T')[0];
        updates.passReason = result.reason ? `not now: ${result.reason}` : 'not now';
        if (result.suggestedFollowupDate) {
          updates.nextFollowupDate = result.suggestedFollowupDate;
        }
        break;
      }
      case 'out_of_office': {
        // No status change; just record the classification + clear
        // replyDetectedAt so the follow-up agent picks them back up (the OOO
        // wasn't a real reply).
        updates.replyDetectedAt = null;
        break;
      }
      case 'needs_human':
      case 'wrong_person': {
        // No status change — admin will handle from the new panel.
        break;
      }
    }

    await db.update(introRequests).set(updates).where(eq(introRequests.id, intro.id));
    classified++;
    rows.push({
      introId: intro.id,
      founderName: founder.name,
      investorName: investor.name,
      action: 'classified',
      classification: result.classification,
      confidence: result.confidence,
      reason: result.reason,
      draftedHandoff,
      autoSentHandoff,
    });
  }

  return { checked: candidates.length, classified, drafted, autoSent, skipped, rows };
}

// Read helper: the rows the new "Replies needing you" panel displays.
// Anything classified as needs_human OR wrong_person, status still
// intro_request_sent (so it hasn't been resolved). Oldest reply first.
export async function getRepliesNeedingHuman(): Promise<{
  rows: Array<{
    introId: number;
    founderName: string;
    companyName: string;
    investorName: string;
    investorFirm: string | null;
    classification: string;
    confidence: number | null;
    reason: string | null;
    snippet: string | null;
    classifiedAt: string | null;
    gmailThreadId: string | null;
  }>;
}> {
  const intros = await db.select().from(introRequests).where(and(
    eq(introRequests.status, 'intro_request_sent'),
    sql`${introRequests.replyClassification} IN ('needs_human','wrong_person')`,
  ));

  const investorIds = Array.from(new Set(intros.map(i => i.investorId)));
  const founderIds = Array.from(new Set(intros.map(i => i.founderId)));
  const [investorRows, founderRows] = await Promise.all([
    investorIds.length ? db.select().from(investors).where(sql`${investors.id} IN (${sql.join(investorIds.map(i => sql`${i}`), sql`,`)})`) : [],
    founderIds.length ? db.select().from(founders).where(sql`${founders.id} IN (${sql.join(founderIds.map(i => sql`${i}`), sql`,`)})`) : [],
  ]);
  const invMap = new Map(investorRows.map(i => [i.id, i]));
  const foundMap = new Map(founderRows.map(f => [f.id, f]));

  const rows = intros.map(intro => {
    const inv = invMap.get(intro.investorId);
    const found = foundMap.get(intro.founderId);
    return {
      introId: intro.id,
      founderName: found?.name || 'Unknown',
      companyName: found?.companyName || '',
      investorName: inv?.name || 'Unknown',
      investorFirm: inv?.firm ?? null,
      classification: intro.replyClassification || '',
      confidence: intro.replyClassificationConfidence ? Number(intro.replyClassificationConfidence) : null,
      reason: intro.passReason,
      snippet: intro.replyBodySnippet,
      classifiedAt: intro.replyClassificationAt,
      gmailThreadId: intro.gmailThreadId,
    };
  });

  rows.sort((a, b) => (a.classifiedAt || '').localeCompare(b.classifiedAt || ''));
  return { rows };
}
