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
import { getStatus as getGmailStatus, getLatestMessageFromSender, createDraft, sendGmail, sendThreadReply, labelAndArchiveThread, stripQuotedReply, hasOperatorReplyAfterMessage } from './gmail.js';
import { classifyReply, type ReplyClass } from './reply-llm.js';
import { recordAction, proposeAction } from './agent-actions.js';

// Read the singleton agent_settings row. Falls back to safe defaults if the
// row is missing for some reason.
async function loadAgentSettings(): Promise<{
  autoSendHandoff: boolean;
  autoSendHandoffMinConfidence: number;
  autoSendHandoffMaxReplyChars: number;
  autoReplyToPass: boolean;
  autoReplyToPassMaxReplyChars: number;
}> {
  const row = await db.query.agentSettings.findFirst({ where: eq(agentSettings.id, 1) });
  return {
    autoSendHandoff: row?.autoSendHandoff ?? false,
    autoSendHandoffMinConfidence: row?.autoSendHandoffMinConfidence ? Number(row.autoSendHandoffMinConfidence) : 0.9,
    autoSendHandoffMaxReplyChars: row?.autoSendHandoffMaxReplyChars ?? 400,
    autoReplyToPass: row?.autoReplyToPass ?? false,
    autoReplyToPassMaxReplyChars: row?.autoReplyToPassMaxReplyChars ?? 1500,
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

  // Pull every "still waiting" intro that has a Gmail thread. We DO NOT
  // require replyDetectedAt to be set — that decouples reply detection
  // from the once-daily follow-up tick (which previously was the only
  // path that flipped that flag). Now this hourly tick is both the
  // detector AND the classifier, so an overnight reply lands within
  // ~60 min instead of waiting until 11am AZ.
  const candidates = await db.select().from(introRequests).where(and(
    eq(introRequests.status, 'intro_request_sent'),
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
      // Investor hasn't replied yet — this is the common case for most
      // pending intros. Skip quietly (don't pollute the result log).
      continue;
    }
    // Flag that we found a reply if it wasn't already flagged. Other parts
    // of the app (pending-replies panel, follow-up cooldown logic) rely on
    // this field.
    if (!intro.replyDetectedAt) {
      await db.update(introRequests).set({
        replyDetectedAt: msg.receivedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).where(eq(introRequests.id, intro.id));
    }

    // Strip the quoted original + signature so length checks and the classifier
    // see only what the investor actually typed (Gmail appends the whole thread).
    const cleanBody = stripQuotedReply(msg.body);

    // 2. Classify
    let result;
    try {
      result = await classifyReply(cleanBody, {
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
    const snippet = cleanBody.trim().slice(0, 500);
    const updates: Record<string, unknown> = {
      replyClassification: result.classification,
      replyClassificationAt: now,
      replyClassificationConfidence: String(result.confidence),
      replyBodySnippet: snippet,
      updatedAt: now,
    };

    let draftedHandoff = false;
    let autoSentHandoff = false;
    let autoRepliedPass = false;

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
          // Make the intro in a FRESH thread (not a reply on the investor's
          // reply thread): a clean double-opt-in email to BOTH parties.
          // NOTE: we don't store per-founder titles, so the founder's title
          // defaults to "Founder/CEO" — admin edits the draft before sending.
          const founderTitle = 'Founder/CEO';
          const investorDesc = investor.firm
            ? `investor at ${investor.firm} who wanted to learn more`
            : 'investor who wanted to learn more';
          // Subject is "<Founder> x <Investor>" — the founder's name, not the
          // company (the company shows in the body).
          const subject = `${founder.name} x ${investor.name}`;
          const handoffBody =
            `Hi All,\n\n` +
            `Wanted to make the intro here:\n\n` +
            `${founder.name} - ${founderTitle} of ${founder.companyName}\n` +
            `${investor.name} - ${investorDesc}\n\n` +
            `I'll let you all take it from here.\n\n` +
            `- Mat Sherman`;
          // Both parties on the To line ("Hi All").
          const to = [investor.email, founder.email].filter(Boolean).join(', ');

          if (canAutoSend) {
            const sent = await sendGmail({ to, subject, body: handoffBody });
            updates.introHandoffSentAt = now;
            updates.introHandoffAutoSent = true;
            updates.introHandoffMessageId = sent.messageId || null;
            autoSentHandoff = true;
            autoSent++;
          } else {
            const draft = await createDraft({ to, subject, body: handoffBody });
            if (draft.draftId) {
              updates.introHandoffDraftId = draft.draftId;
              updates.introHandoffDraftCreatedAt = now;
              draftedHandoff = true;
              drafted++;
            }
          }
        } catch (e: any) {
          // Failure here doesn't block the status transition — admin can
          // write the intro themselves.
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
        // A soft pass — treated as a pass. We keep the reason for analytics, but
        // deliberately DON'T track a follow-up date: "not now" is statistically a
        // no, and a circle-back date just manufactures false hope for everyone.
        updates.status = 'passed';
        updates.datePassed = now.split('T')[0];
        updates.passReason = result.reason ? `not now: ${result.reason}` : 'not now';
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

    // Acknowledge + archive a high-confidence pass. Covers BOTH a clean "no" and
    // a soft "not now" — both are passes (a "not now" is statistically a no, and
    // a verbose/hedged pass often lands as not_now). Behind the kill switch + the
    // same confidence floor as the handoff. Reply is investor-only, in-thread;
    // the thread is labeled "Passed" and archived (still findable).
    if (
      (result.classification === 'no' || result.classification === 'not_now') &&
      settings.autoReplyToPass &&
      result.confidence >= settings.autoSendHandoffMinConfidence &&
      // Only auto-ack SHORT passes. A long, multi-paragraph "pass" usually
      // carries nuance (interest in another deal, a question, a request) that
      // deserves a real reply — never silently thank-and-archive those. Measure
      // the cleaned reply (quoted thread stripped), not the raw body.
      cleanBody.trim().length <= settings.autoReplyToPassMaxReplyChars
    ) {
      try {
        // Never step on a manual reply. If Mat already answered in this thread
        // after the investor's pass, leave it entirely alone — no canned ack and
        // no archive (he's handling it, so keep it in his inbox).
        const humanReplied = await hasOperatorReplyAfterMessage(intro.gmailThreadId!, msg.messageId);
        if (humanReplied) {
          console.log(`[reply-classifier] skipping pass auto-reply: human already replied in thread for intro #${intro.id} (${investor.name})`);
        } else {
          // A hard "no" explicitly passed → acknowledge the pass. A soft "not now"
          // ("we'll look / sent it to the team") hasn't actually said no, so a bare
          // "Thanks!" is right — we still mark it passed internally either way.
          const replyBody = result.classification === 'no'
            ? `All good, thanks for letting me know!\n\n- Mat`
            : `Thanks!\n\n- Mat`;
          await sendThreadReply({
            threadId: intro.gmailThreadId!,
            to: investor.email!,
            subject: `Re: ${founder.companyName || founder.name}`,
            body: replyBody,
            asDraft: false,
          });
          await labelAndArchiveThread(intro.gmailThreadId!, 'Passed');
          updates.passAutoRepliedAt = now;
          autoRepliedPass = true;
          console.log(`[reply-classifier] auto-replied + archived pass: intro #${intro.id} (${investor.name})`);
        }
      } catch (e: any) {
        // Non-fatal — the pass status is already recorded.
        console.error('[reply-classifier] pass auto-reply/archive failed:', e);
      }
    }

    await db.update(introRequests).set(updates).where(eq(introRequests.id, intro.id));
    classified++;

    // Everything the classifier does flows through the agent_actions ledger so
    // it shows in the AI Agent tab: work it DID -> recordAction (audit); work it
    // NEEDS YOU for -> proposeAction (awaiting-you, drives the digest email).
    const who = `${investor.name} → ${founder.name}`;
    try {
      if (result.classification === 'needs_human' || result.classification === 'wrong_person') {
        await proposeAction({
          agent: 'reply-classifier',
          actionType: `reply_${result.classification}`,
          summary: `Investor reply needs you: ${who} (${result.classification})`,
          reasoning: result.reason || undefined,
          entityType: 'intro_request',
          entityId: intro.id,
          payload: { classification: result.classification, confidence: result.confidence, snippet },
        });
      } else {
        const did =
          result.classification === 'yes'
            ? (autoSentHandoff ? 'Auto-sent handoff intro' : draftedHandoff ? 'Drafted handoff intro' : 'Marked introduced')
            : result.classification === 'no'
              ? (autoRepliedPass ? 'Auto-replied + archived pass' : 'Marked passed')
              : result.classification === 'not_now'
                ? (autoRepliedPass ? 'Auto-replied + archived pass (soft "not now")' : 'Marked passed (soft "not now")')
                : 'Logged out-of-office';
        await recordAction({
          agent: 'reply-classifier',
          actionType: `reply_${result.classification}`,
          summary: `${did}: ${who}`,
          reasoning: result.reason || undefined,
          entityType: 'intro_request',
          entityId: intro.id,
          payload: { classification: result.classification, confidence: result.confidence },
          status: 'executed',
        });
      }
    } catch (e) {
      console.error('[reply-classifier] ledger log failed:', e);
    }

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

/**
 * One-shot backfill: acknowledge passes that were classified BEFORE the
 * quote-stripping fix and so never got an auto-reply (the raw body looked too
 * long). Idempotent — only touches passes with pass_auto_replied_at still null,
 * and re-applies the same gate (toggle on, confidence floor, cleaned length).
 */
export async function runPassAckBackfill(sinceDays = 7): Promise<{
  eligible: number;
  acked: number;
  skipped: number;
  rows: Array<{ introId: number; investorName: string; result: string }>;
}> {
  const out: Array<{ introId: number; investorName: string; result: string }> = [];
  const gmail = await getGmailStatus();
  if (!gmail.connected) return { eligible: 0, acked: 0, skipped: 0, rows: [{ introId: 0, investorName: '', result: 'gmail not connected' }] };

  const settings = await loadAgentSettings();
  if (!settings.autoReplyToPass) {
    return { eligible: 0, acked: 0, skipped: 0, rows: [{ introId: 0, investorName: '', result: 'auto-reply-to-pass is OFF' }] };
  }

  // Passes that were marked passed by the classifier but never auto-acked. Scoped
  // to the recent window so we never surprise-reply to a weeks-old pass.
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const candidates = await db.select().from(introRequests).where(and(
    eq(introRequests.status, 'passed'),
    sql`${introRequests.replyClassification} IN ('no','not_now')`,
    isNull(introRequests.passAutoRepliedAt),
    sql`${introRequests.datePassed} >= ${cutoff}`,
    sql`${introRequests.gmailThreadId} IS NOT NULL AND ${introRequests.gmailThreadId} != ''`,
  ));

  let acked = 0;
  let skipped = 0;
  for (const intro of candidates) {
    const investor = await db.query.investors.findFirst({ where: eq(investors.id, intro.investorId) });
    const founder = await db.query.founders.findFirst({ where: eq(founders.id, intro.founderId) });
    if (!investor?.email || !founder || !intro.gmailThreadId) { skipped++; continue; }

    const conf = intro.replyClassificationConfidence ? Number(intro.replyClassificationConfidence) : 0;
    if (conf < settings.autoSendHandoffMinConfidence) {
      skipped++;
      out.push({ introId: intro.id, investorName: investor.name, result: `skip: confidence ${conf} < ${settings.autoSendHandoffMinConfidence}` });
      continue;
    }

    let msg;
    try {
      msg = await getLatestMessageFromSender(intro.gmailThreadId, investor.email);
    } catch (e: any) {
      skipped++; out.push({ introId: intro.id, investorName: investor.name, result: `skip: gmail ${e.message || e}` });
      continue;
    }
    if (!msg) { skipped++; out.push({ introId: intro.id, investorName: investor.name, result: 'skip: reply not found' }); continue; }

    const cleanBody = stripQuotedReply(msg.body);
    if (cleanBody.trim().length > settings.autoReplyToPassMaxReplyChars) {
      skipped++;
      out.push({ introId: intro.id, investorName: investor.name, result: `skip: ${cleanBody.trim().length} chars > ${settings.autoReplyToPassMaxReplyChars}` });
      continue;
    }

    // Never step on a manual reply. Especially important on backfill: these are
    // older passes, so Mat is even more likely to have answered by hand already.
    try {
      if (await hasOperatorReplyAfterMessage(intro.gmailThreadId, msg.messageId)) {
        skipped++;
        out.push({ introId: intro.id, investorName: investor.name, result: 'skip: human already replied' });
        continue;
      }
    } catch (e: any) {
      // If we can't check the thread, fail open and let the send gates below decide.
      console.error('[reply-classifier] backfill human-reply check failed:', e);
    }

    const now = new Date().toISOString();
    try {
      const replyBody = intro.replyClassification === 'no'
        ? `All good, thanks for letting me know!\n\n- Mat`
        : `Thanks!\n\n- Mat`;
      await sendThreadReply({
        threadId: intro.gmailThreadId,
        to: investor.email,
        subject: `Re: ${founder.companyName || founder.name}`,
        body: replyBody,
        asDraft: false,
      });
      await labelAndArchiveThread(intro.gmailThreadId, 'Passed');
      await db.update(introRequests).set({ passAutoRepliedAt: now, updatedAt: now }).where(eq(introRequests.id, intro.id));
      acked++;
      out.push({ introId: intro.id, investorName: investor.name, result: 'acked' });
      try {
        await recordAction({
          agent: 'reply-classifier', actionType: 'reply_pass_backfill',
          summary: `Auto-replied + archived pass (backfill): ${investor.name} → ${founder.name}`,
          entityType: 'intro_request', entityId: intro.id, status: 'executed',
        });
      } catch { /* ledger best-effort */ }
    } catch (e: any) {
      skipped++;
      out.push({ introId: intro.id, investorName: investor.name, result: `error: ${e.message || e}` });
    }
  }

  return { eligible: candidates.length, acked, skipped, rows: out };
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
