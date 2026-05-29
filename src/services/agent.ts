import { eq, inArray, and, isNull, desc, gte, lt, or, sql } from 'drizzle-orm';
import { db, founders, investors, nodes, matchSuggestions, introRequests, type MatchSuggestion } from '../db/index.js';
import { generateMatchSuggestions } from './matching.js';
import { sendEmail } from './email.js';
import { buildIntroBody, createDraft, getStatus as getGmailStatus, checkThreadReplies, sendThreadReply } from './gmail.js';

/**
 * Phase 1 shadow agent — runs match generation on a schedule and emails an
 * admin digest of "what I'd intro." Suggestions land in match_suggestions
 * with status='pending'; admin approves each one in the matching tab.
 *
 * No new approval surface, no auto-send. Just visibility + a forcing function
 * so the queue gets reviewed regularly.
 */
export async function runAgentTick(): Promise<{
  generated: number;
  topRecommendations: number;
  emailSent: boolean;
  recipient: string;
  diagnostics?: {
    eligibleFounders: number;
    perFounder: Array<{
      founder: string;
      target: number;
      usedThisWeek: number;
      remaining: number;
      totalReachable: number;
      available: number;
      blockedByExisting: number;
      blockedByFirm: number;
      blockedByCooldown: number;
      blockedByClaimed: number;
      blockedByTripleDup: number;
      blockedByVipGate: number;
      blockedByVipNode: number;
      blockedByGeo: number;
      blockedByCategory: number;
      generated: number;
      targetSource: 'dynamic' | 'manual';
      targetSupplyBased: number;
      targetHeatBased: number;
      targetManualBaseline: number;
    }>;
  };
}> {
  const baseUrl = process.env.BASE_URL || 'https://matcap.vc';
  const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';

  // 1. Generate fresh suggestions across all eligible founders.
  const { suggestions, batchId, liquidity } = await generateMatchSuggestions();

  // 2. Persist each suggestion as a pending intro_request + linked match_suggestion.
  // generateMatchSuggestions only returns in-memory candidates — the /api/matching/generate
  // endpoint does this same write, but the shadow agent path needs it too.
  const now = new Date().toISOString();
  for (const s of suggestions) {
    const [introRequest] = await db.insert(introRequests).values({
      founderId: s.founderId,
      nodeId: s.nodeId,
      investorId: s.investorId,
      status: 'pending_suggestion',
      notes: `Match Score: ${s.matchScore}`,
      createdAt: now,
      updatedAt: now,
    }).returning();
    await db.insert(matchSuggestions).values({
      founderId: s.founderId,
      nodeId: s.nodeId,
      investorId: s.investorId,
      founderHeatScore: s.founderHeatScore,
      investorReliabilityScore: s.investorReliabilityScore,
      matchScore: s.matchScore,
      matchReasoning: s.matchReasoning,
      batchId: s.batchId,
      status: 'pending',
      introRequestId: introRequest.id,
      createdAt: now,
    });
  }

  // 3. Pull the just-created pending suggestions back (with the new batchId)
  //    so we have ids to link to from the email.
  const fresh = await db.select().from(matchSuggestions)
    .where(eq(matchSuggestions.batchId, batchId));

  // 3. Top picks: score >= 70, sorted desc. Cap at 25 in the email.
  const SCORE_THRESHOLD = 70;
  const top = fresh
    .filter(s => (s.matchScore ?? 0) >= SCORE_THRESHOLD)
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
    .slice(0, 25);

  // Resolve names for the email
  const founderIds = Array.from(new Set(top.map(s => s.founderId)));
  const investorIds = Array.from(new Set(top.map(s => s.investorId)));
  const nodeIds = Array.from(new Set(top.map(s => s.nodeId)));
  const [founderRows, investorRows, nodeRows] = await Promise.all([
    founderIds.length ? db.select({ id: founders.id, name: founders.name, company: founders.companyName }).from(founders).where(inArray(founders.id, founderIds)) : [],
    investorIds.length ? db.select({ id: investors.id, name: investors.name, firm: investors.firm }).from(investors).where(inArray(investors.id, investorIds)) : [],
    nodeIds.length ? db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(inArray(nodes.id, nodeIds)) : [],
  ]);
  const fName = new Map(founderRows.map(f => [f.id, f]));
  const iName = new Map(investorRows.map(i => [i.id, i]));
  const nName = new Map(nodeRows.map(n => [n.id, n.name]));

  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));

  const renderReasoning = (s: MatchSuggestion): string => {
    try {
      const r = s.matchReasoning ? JSON.parse(s.matchReasoning) : null;
      if (!r) return '';
      const parts: string[] = [];
      if (r.connectionStrength) parts.push(`${r.connectionStrength} tie`);
      if (r.sectorFit && r.sectorFit !== 'untagged') parts.push(`sector ${r.sectorFit}`);
      if (r.stageFit === 'exact') parts.push('stage exact');
      if (r.personaFit === 'exact') parts.push('persona exact');
      if (typeof r.weeksSinceContact === 'number') parts.push(`${r.weeksSinceContact}w stale`);
      return parts.join(' · ');
    } catch { return ''; }
  };

  const rowsHtml = top.map(s => {
    const f = fName.get(s.founderId);
    const i = iName.get(s.investorId);
    const n = nName.get(s.nodeId) || '—';
    const founderLabel = f ? `${escapeHtml(f.name)} (${escapeHtml(f.company)})` : `Founder #${s.founderId}`;
    const investorLabel = i ? (i.firm ? `${escapeHtml(i.name)} @ ${escapeHtml(i.firm)}` : escapeHtml(i.name)) : `Investor #${s.investorId}`;
    const reasoning = renderReasoning(s);
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600">${s.matchScore}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${founderLabel}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${investorLabel}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#555">via ${escapeHtml(n)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#888;font-size:12px">${escapeHtml(reasoning)}</td>
    </tr>`;
  }).join('\n');

  const subject = top.length === 0
    ? `Agent run — 0 high-score picks (${suggestions.length} total)`
    : `Agent: ${top.length} intro${top.length === 1 ? '' : 's'} ready for review`;

  const html = `
<div style="font-family:Inter,system-ui,sans-serif;max-width:780px;margin:0 auto;color:#222">
  <h2 style="margin:0 0 4px 0">Agent recommendations</h2>
  <p style="margin:0 0 16px 0;color:#666">
    ${top.length} pick${top.length === 1 ? '' : 's'} with score ≥ ${SCORE_THRESHOLD}.
    ${suggestions.length} total suggestions generated this run.
  </p>
  ${top.length === 0
    ? '<p style="color:#888"><em>No high-score matches this run. Either everything is on cooldown, or there\'s a coverage gap (check Marketplace Health).</em></p>'
    : `<table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f6f7f8">
            <th style="padding:8px 10px;text-align:left">Score</th>
            <th style="padding:8px 10px;text-align:left">Founder</th>
            <th style="padding:8px 10px;text-align:left">Investor</th>
            <th style="padding:8px 10px;text-align:left">Path</th>
            <th style="padding:8px 10px;text-align:left">Why</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`
  }
  <p style="margin-top:20px">
    <a href="${baseUrl}/admin#matching" style="display:inline-block;background:#2563eb;color:white;padding:10px 18px;border-radius:6px;text-decoration:none">Open admin to approve →</a>
  </p>
  <p style="color:#999;font-size:12px;margin-top:16px">
    Shadow mode: nothing has been sent. Open the matching tab to approve, reject, or shuffle each pick.
    Batch id: <code>${escapeHtml(batchId)}</code>
  </p>
</div>`;

  const text = top.length === 0
    ? `Agent recommendations\n\nNo high-score matches this run. ${suggestions.length} total suggestions generated.\n\nOpen ${baseUrl}/admin#matching to review.`
    : `Agent recommendations\n\n${top.length} picks with score >= ${SCORE_THRESHOLD} (of ${suggestions.length} total).\n\n${
        top.map(s => {
          const f = fName.get(s.founderId);
          const i = iName.get(s.investorId);
          const n = nName.get(s.nodeId) || '—';
          return `[${s.matchScore}] ${f?.name ?? `Founder #${s.founderId}`} → ${i?.name ?? `Investor #${s.investorId}`}${i?.firm ? ` @ ${i.firm}` : ''} via ${n} — ${renderReasoning(s)}`;
        }).join('\n')
      }\n\nApprove: ${baseUrl}/admin#matching\n\nBatch: ${batchId}`;

  let emailSent = false;
  try {
    await sendEmail({ to: adminEmail, subject, html, text });
    emailSent = true;
  } catch (e) {
    console.error('Agent: failed to send digest email', e);
  }

  const founderNameMap = new Map(founderRows.map(f => [f.id, f.name]));
  // Re-fetch names for founders that appeared in liquidity but didn't make top picks
  const missingFounderIds = liquidity.map(l => l.founderId).filter(id => !founderNameMap.has(id));
  if (missingFounderIds.length) {
    const extra = await db.select({ id: founders.id, name: founders.name })
      .from(founders).where(inArray(founders.id, missingFounderIds));
    for (const f of extra) founderNameMap.set(f.id, f.name);
  }

  return {
    generated: suggestions.length,
    topRecommendations: top.length,
    emailSent,
    recipient: adminEmail,
    diagnostics: {
      eligibleFounders: liquidity.length,
      perFounder: liquidity.map(l => ({
        founder: founderNameMap.get(l.founderId) || `#${l.founderId}`,
        target: l.weeklyTarget,
        usedThisWeek: l.usedThisWeek,
        remaining: l.remaining,
        totalReachable: l.totalReachableInvestors,
        available: l.availableInvestors,
        blockedByExisting: l.blockedByExisting,
        blockedByFirm: l.blockedByFirm,
        blockedByCooldown: l.blockedByCooldown,
        blockedByClaimed: l.blockedByClaimed,
        blockedByTripleDup: l.blockedByTripleDup,
        blockedByVipGate: l.blockedByVipGate,
        blockedByVipNode: l.blockedByVipNode,
        blockedByGeo: l.blockedByGeo,
        blockedByCategory: l.blockedByCategory,
        generated: l.generated,
        targetSource: l.targetSource,
        targetSupplyBased: l.targetSupplyBased,
        targetHeatBased: l.targetHeatBased,
        targetManualBaseline: l.targetManualBaseline,
      })),
    },
  };
}

/**
 * Auto-draft tick: walks the pending-suggestion queue and creates Gmail
 * drafts up to the per-founder caps. Does NOT change status — drafts sit
 * in user's Gmail awaiting their review.
 *
 * Per-founder caps (not per-system):
 *   - 1 auto-draft per founder per 24h
 *   - 5 auto-drafts per founder per 7 days
 *
 * Hard preflight checks:
 *   - Gmail must be connected
 *   - Investor must have an email on file
 *   - Suggestion must have matchScore >= AUTO_DRAFT_MIN_SCORE (default 80)
 *   - Suggestion must not already have a gmailDraftId
 */
const AUTO_DRAFT_MIN_SCORE = parseInt(process.env.AUTO_DRAFT_MIN_SCORE || '80', 10);
const AUTO_DRAFT_PER_FOUNDER_PER_DAY = 1;
const AUTO_DRAFT_PER_FOUNDER_PER_WEEK = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export async function runAutoDraftTick(): Promise<{
  drafted: number;
  skipped?: string;
  results: Array<{
    draftId: string;
    gmailUrl: string;
    founderName: string;
    investorName: string;
    matchScore: number;
  }>;
  skippedBreakdown?: {
    total: number;
    underScore: number;
    noInvestorEmail: number;
    existingDraft: number;
    notPendingSuggestion: number;
    perFounderDayCap: number;
    perFounderWeekCap: number;
    missingFounder: number;
    missingIntroRequest: number;
    minScoreThreshold: number;
  };
}> {
  // 1. Gmail must be connected
  const gmail = await getGmailStatus();
  if (!gmail.connected) {
    return { drafted: 0, skipped: 'Gmail not connected', results: [] };
  }

  // Per-founder caps: build maps of drafts created in the last 24h and 7d
  // by reading intro_requests.gmail_draft_created_at. We use these to skip
  // founders who've already hit their quota for the window.
  const dayCutoff = new Date(Date.now() - DAY_MS).toISOString();
  const weekCutoff = new Date(Date.now() - WEEK_MS).toISOString();
  const recentByFounder = await db.select({
    founderId: introRequests.founderId,
    createdAt: introRequests.gmailDraftCreatedAt,
  })
    .from(introRequests)
    .where(and(
      gte(introRequests.gmailDraftCreatedAt, weekCutoff),
    ));
  const draftsLastDay = new Map<number, number>();
  const draftsLastWeek = new Map<number, number>();
  for (const r of recentByFounder) {
    if (!r.createdAt) continue;
    draftsLastWeek.set(r.founderId, (draftsLastWeek.get(r.founderId) || 0) + 1);
    if (r.createdAt >= dayCutoff) {
      draftsLastDay.set(r.founderId, (draftsLastDay.get(r.founderId) || 0) + 1);
    }
  }

  // Pull all pending suggestions (not pre-filtered by score) so we can count
  // and report each skip reason. The score gate is applied in the JS loop.
  const candidates = await db.select({
    suggestionId: matchSuggestions.id,
    introRequestId: matchSuggestions.introRequestId,
    matchScore: matchSuggestions.matchScore,
    founderId: matchSuggestions.founderId,
    investorId: matchSuggestions.investorId,
    nodeId: matchSuggestions.nodeId,
  })
    .from(matchSuggestions)
    .where(eq(matchSuggestions.status, 'pending'))
    .orderBy(desc(matchSuggestions.matchScore))
    .limit(500);

  const results: Array<{ draftId: string; gmailUrl: string; founderName: string; investorName: string; matchScore: number }> = [];
  const skipped = {
    total: candidates.length,
    underScore: 0,
    noInvestorEmail: 0,
    existingDraft: 0,
    notPendingSuggestion: 0,
    perFounderDayCap: 0,
    perFounderWeekCap: 0,
    missingFounder: 0,
    missingIntroRequest: 0,
    minScoreThreshold: AUTO_DRAFT_MIN_SCORE,
  };

  for (const c of candidates) {
    if (!c.introRequestId) { skipped.missingIntroRequest++; continue; }
    if ((c.matchScore ?? 0) < AUTO_DRAFT_MIN_SCORE) { skipped.underScore++; continue; }

    const dayCount = draftsLastDay.get(c.founderId) || 0;
    const weekCount = draftsLastWeek.get(c.founderId) || 0;
    if (dayCount >= AUTO_DRAFT_PER_FOUNDER_PER_DAY) { skipped.perFounderDayCap++; continue; }
    if (weekCount >= AUTO_DRAFT_PER_FOUNDER_PER_WEEK) { skipped.perFounderWeekCap++; continue; }

    const intro = await db.query.introRequests.findFirst({ where: eq(introRequests.id, c.introRequestId) });
    if (!intro) { skipped.missingIntroRequest++; continue; }
    if (intro.status !== 'pending_suggestion') { skipped.notPendingSuggestion++; continue; }
    if (intro.gmailDraftId) { skipped.existingDraft++; continue; }

    const investor = await db.query.investors.findFirst({ where: eq(investors.id, c.investorId) });
    if (!investor || !investor.email) { skipped.noInvestorEmail++; continue; }

    const founder = await db.query.founders.findFirst({ where: eq(founders.id, c.founderId) });
    const node = await db.query.nodes.findFirst({ where: eq(nodes.id, c.nodeId) });
    if (!founder) { skipped.missingFounder++; continue; }

    // Build email + draft
    const { subject, body } = buildIntroBody({
      founder: {
        name: founder.name,
        companyName: founder.companyName,
        email: founder.email,
        blurb: founder.blurb,
        companyStage: founder.companyStage,
        deckUrl: founder.deckUrl,
        calendlyUrl: founder.calendlyUrl,
      },
      investor: { name: investor.name, firm: investor.firm, role: investor.role },
      node: node ? { name: node.name } : null,
    });

    let attachmentPath: string | undefined;
    let attachmentName: string | undefined;
    if (founder.deckFile) {
      const dataDir = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.');
      attachmentPath = `${dataDir}/decks/${founder.deckFile}`;
      attachmentName = `${founder.companyName || founder.name} Deck.pdf`;
    }

    try {
      const draftResult = await createDraft({
        to: investor.email,
        subject,
        body,
        attachmentPath,
        attachmentName,
      });

      const now = new Date().toISOString();
      await db.update(introRequests)
        .set({
          gmailDraftId: draftResult.draftId,
          gmailDraftCreatedAt: now,
          updatedAt: now,
        })
        .where(eq(introRequests.id, intro.id));

      // Notify admin
      const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
      const baseUrl = process.env.BASE_URL || 'https://matcap.vc';
      const subjectLine = `Agent: draft ready — ${founder.name} → ${investor.name}${investor.firm ? ` (${investor.firm})` : ''}`;
      const reviewUrl = `${baseUrl}/admin#intros`;
      try {
        await sendEmail({
          to: adminEmail,
          subject: subjectLine,
          html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:640px;margin:0 auto;color:#222">
            <h2 style="margin:0 0 8px 0">Agent drafted a Gmail intro</h2>
            <p style="color:#555;margin:0 0 16px 0">Score <strong>${c.matchScore}</strong>. Draft is in your Gmail Drafts (and Superhuman). Review and send, or discard.</p>
            <table style="border-collapse:collapse;font-size:14px">
              <tr><td style="padding:4px 12px;color:#888">Founder</td><td style="padding:4px 12px;font-weight:600">${founder.name} (${founder.companyName})</td></tr>
              <tr><td style="padding:4px 12px;color:#888">Investor</td><td style="padding:4px 12px">${investor.name}${investor.firm ? ' @ ' + investor.firm : ''}</td></tr>
              <tr><td style="padding:4px 12px;color:#888">To</td><td style="padding:4px 12px">${investor.email}</td></tr>
              <tr><td style="padding:4px 12px;color:#888">Attachment</td><td style="padding:4px 12px">${attachmentPath ? '📎 ' + (attachmentName || 'deck.pdf') : 'none'}</td></tr>
            </table>
            <p style="margin-top:20px">
              <a href="${draftResult.gmailUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;margin-right:8px">Open draft in Gmail →</a>
              <a href="${reviewUrl}" style="display:inline-block;color:#2563eb;text-decoration:underline">Admin: intro requests</a>
            </p>
          </div>`,
          text: `Agent drafted a Gmail intro\n\nFounder: ${founder.name} (${founder.companyName})\nInvestor: ${investor.name}${investor.firm ? ' @ ' + investor.firm : ''}\nTo: ${investor.email}\nScore: ${c.matchScore}\n\nOpen draft: ${draftResult.gmailUrl}\nAdmin: ${reviewUrl}`,
        });
      } catch (e) { console.error('[AUTO-DRAFT] Failed to notify admin', e); }

      results.push({
        draftId: draftResult.draftId,
        gmailUrl: draftResult.gmailUrl,
        founderName: founder.name,
        investorName: investor.name,
        matchScore: c.matchScore ?? 0,
      });
      // Bump per-founder counters so subsequent candidates respect the cap in
      // the same tick (otherwise we'd draft 5 in one run for a hot founder).
      draftsLastDay.set(c.founderId, dayCount + 1);
      draftsLastWeek.set(c.founderId, weekCount + 1);
    } catch (err) {
      console.error('[AUTO-DRAFT] createDraft failed', err);
      continue;
    }
  }

  if (results.length === 0) {
    return {
      drafted: 0,
      results: [],
      skipped: `No eligible candidates of ${skipped.total} pending. Breakdown: score<${AUTO_DRAFT_MIN_SCORE}: ${skipped.underScore}, no investor email: ${skipped.noInvestorEmail}, existing draft: ${skipped.existingDraft}, not pending: ${skipped.notPendingSuggestion}, day-cap: ${skipped.perFounderDayCap}, week-cap: ${skipped.perFounderWeekCap}`,
      skippedBreakdown: skipped,
    };
  }
  return { drafted: results.length, results, skippedBreakdown: skipped };
}

// --- Follow-up Agent (Phase 1) ---
//
// For every sent intro that hasn't gotten a reply in 7+ days and hasn't already
// been followed up on this cycle, draft a short bump in the same Gmail thread.
// Drafts (not sends) — admin reviews + sends manually for now.
//
// Stops automatically when:
//   - investor has replied (replyDetectedAt set)
//   - followupCount >= MAX_FOLLOWUPS (1)
//   - last follow-up was < 7 days ago

// Two-stage follow-up: a polite bump in the 7-21 day window, then a "close
// the loop" ask once we're past 21 days. Max one of each, so each intro can
// see up to 2 follow-ups total.
const MAX_FOLLOWUPS = 2;
const FOLLOWUP_GAP_DAYS = 7;
const CLOSE_LOOP_DAYS = 21;

// Polite bump — 7-21 days since intro request, no reply yet.
const FOLLOWUP_POLITE = 'Hey {{first}} — wanted to bump this. Any additional info I can share to help you get to a yes (for the intro) or pass? Thanks!';

// Close-the-loop — 21+ days. More direct, asks for any response.
const FOLLOWUP_CLOSE_LOOP = `Hey {{first}} — wanted to circle back. I'd rather hear from you than assume it's a pass, but sometimes intros just don't get seen the first time around.\n\nQuick yes / no / not now?`;

// Pick the template that fits the intro's age. Pass the dateRequested string
// (YYYY-MM-DD) — returns one of the two strings above.
function pickFollowupTemplate(dateRequested: string | null): string {
  if (!dateRequested) return FOLLOWUP_POLITE;
  const days = Math.floor((Date.now() - new Date(dateRequested).getTime()) / 86400000);
  return days >= CLOSE_LOOP_DAYS ? FOLLOWUP_CLOSE_LOOP : FOLLOWUP_POLITE;
}

export async function runFollowupTick(): Promise<{
  checked: number;
  drafted: number;
  repliesDetected: number;
  results: Array<{
    introId: number;
    founderName: string;
    investorName: string;
    action: 'drafted' | 'reply-detected' | 'skipped';
    detail?: string;
  }>;
}> {
  const gmail = await getGmailStatus();
  if (!gmail.connected) {
    return { checked: 0, drafted: 0, repliesDetected: 0, results: [] };
  }

  const cutoff = new Date(Date.now() - FOLLOWUP_GAP_DAYS * 86400 * 1000).toISOString();
  const candidates = await db.select().from(introRequests)
    .where(and(
      eq(introRequests.status, 'intro_request_sent'),
      sql`${introRequests.gmailThreadId} IS NOT NULL AND ${introRequests.gmailThreadId} != ''`,
      isNull(introRequests.replyDetectedAt),
      lt(introRequests.followupCount, MAX_FOLLOWUPS),
      lt(introRequests.dateRequested, cutoff.split('T')[0]),
      or(
        isNull(introRequests.lastFollowupAt),
        lt(introRequests.lastFollowupAt, cutoff),
      ),
    ));

  const results: Array<{ introId: number; founderName: string; investorName: string; action: 'drafted' | 'reply-detected' | 'skipped'; detail?: string }> = [];
  let drafted = 0;
  let repliesDetected = 0;

  for (const intro of candidates) {
    const investor = await db.query.investors.findFirst({ where: eq(investors.id, intro.investorId) });
    const founder = await db.query.founders.findFirst({ where: eq(founders.id, intro.founderId) });
    if (!investor || !investor.email || !founder || !intro.gmailThreadId) continue;

    // 1. Check if the *investor* (not the node) has replied. Passing the
    //    investor's email scopes the check so node forwards in-thread don't
    //    register as the investor replying.
    let threadInfo: { hasReply: boolean; lastReplyAt?: string };
    try {
      threadInfo = await checkThreadReplies(intro.gmailThreadId, investor.email);
    } catch (e: any) {
      results.push({ introId: intro.id, founderName: founder.name, investorName: investor.name, action: 'skipped', detail: `thread check failed: ${e.message || e}` });
      continue;
    }
    if (threadInfo.hasReply) {
      await db.update(introRequests)
        .set({ replyDetectedAt: threadInfo.lastReplyAt || new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(eq(introRequests.id, intro.id));
      repliesDetected++;
      results.push({ introId: intro.id, founderName: founder.name, investorName: investor.name, action: 'reply-detected' });
      continue;
    }

    // 2. Pick the template that fits the intro's age + fill {{first}}
    const investorFirst = (investor.name || '').split(/\s+/)[0] || 'there';
    const template = pickFollowupTemplate(intro.dateRequested);
    const body = template.replace(/\{\{first\}\}/g, investorFirst);

    // 3. Build subject (Re: <original>) and reply in thread
    const originalSubject = founder.companyName || founder.name;
    const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;

    try {
      await sendThreadReply({
        threadId: intro.gmailThreadId,
        to: investor.email,
        subject,
        body,
        asDraft: true,
      });
      const now = new Date().toISOString();
      await db.update(introRequests)
        .set({
          followupCount: (intro.followupCount || 0) + 1,
          lastFollowupAt: now,
          updatedAt: now,
        })
        .where(eq(introRequests.id, intro.id));
      drafted++;
      results.push({ introId: intro.id, founderName: founder.name, investorName: investor.name, action: 'drafted' });
    } catch (e: any) {
      results.push({ introId: intro.id, founderName: founder.name, investorName: investor.name, action: 'skipped', detail: `draft failed: ${e.message || e}` });
    }
  }

  // Notify admin if anything happened
  if (drafted > 0 || repliesDetected > 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
    const baseUrl = process.env.BASE_URL || 'https://matcap.vc';
    const draftedRows = results.filter(r => r.action === 'drafted')
      .map(r => `  • ${r.founderName} → ${r.investorName}`).join('\n');
    const repliedRows = results.filter(r => r.action === 'reply-detected')
      .map(r => `  • ${r.founderName} → ${r.investorName}`).join('\n');
    try {
      await sendEmail({
        to: adminEmail,
        subject: `Follow-up agent: ${drafted} drafts, ${repliesDetected} replies`,
        html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:640px;margin:0 auto;color:#222">
          <h2 style="margin:0 0 8px 0">Follow-up agent run</h2>
          ${drafted > 0 ? `<p><strong>${drafted} bump draft${drafted === 1 ? '' : 's'}</strong> in Gmail Drafts, ready to send:</p><pre style="background:#f6f7f8;padding:12px;border-radius:6px;font-size:13px">${draftedRows}</pre>` : ''}
          ${repliesDetected > 0 ? `<p><strong>${repliesDetected} repl${repliesDetected === 1 ? 'y' : 'ies'} detected</strong> — these are off the follow-up rotation now:</p><pre style="background:#eafbe6;padding:12px;border-radius:6px;font-size:13px">${repliedRows}</pre>` : ''}
          <p style="margin-top:16px"><a href="${baseUrl}/admin#intros">Open admin → intros</a></p>
        </div>`,
        text: `Follow-up agent run\nDrafts: ${drafted}\nReplies detected: ${repliesDetected}\n\n${baseUrl}/admin#intros`,
      });
    } catch (e) { console.error('Follow-up notify failed', e); }
  }

  return { checked: candidates.length, drafted, repliesDetected, results };
}

// List every intro awaiting a reply (status='intro_request_sent', no
// replyDetectedAt). Bucketed by age so the admin UI can show "polite" vs
// "close the loop" cohorts and pick the matching follow-up template.
export async function getPendingReplies(): Promise<{
  rows: Array<{
    introId: number;
    founderId: number;
    founderName: string;
    companyName: string;
    investorId: number;
    investorName: string;
    investorFirm: string | null;
    investorEmail: string | null;
    nodeId: number;
    nodeName: string | null;
    dateRequested: string | null;
    daysSinceRequested: number | null;
    followupCount: number;
    lastFollowupAt: string | null;
    bucket: 'too-fresh' | 'polite' | 'close-loop';
    templatePreview: string;
    canDraftBump: boolean; // false when capped OR in cooldown
    bumpBlockedReason: 'capped' | 'too-fresh' | 'cooldown' | null;
    daysUntilNextBump: number | null;
    gmailThreadId: string | null;
  }>;
}> {
  const intros = await db.select().from(introRequests)
    .where(and(
      eq(introRequests.status, 'intro_request_sent'),
      isNull(introRequests.replyDetectedAt),
    ));

  const investorIds = Array.from(new Set(intros.map(i => i.investorId)));
  const founderIds = Array.from(new Set(intros.map(i => i.founderId)));
  const nodeIds = Array.from(new Set(intros.map(i => i.nodeId)));

  const [investorRows, founderRows, nodeRows] = await Promise.all([
    investorIds.length ? db.select().from(investors).where(inArray(investors.id, investorIds)) : [],
    founderIds.length ? db.select().from(founders).where(inArray(founders.id, founderIds)) : [],
    nodeIds.length ? db.select().from(nodes).where(inArray(nodes.id, nodeIds)) : [],
  ]);
  const invMap = new Map(investorRows.map(i => [i.id, i]));
  const foundMap = new Map(founderRows.map(f => [f.id, f]));
  const nodeMap = new Map(nodeRows.map(n => [n.id, n]));

  const today = Date.now();
  const rows = intros.map(intro => {
    const inv = invMap.get(intro.investorId);
    const found = foundMap.get(intro.founderId);
    const node = nodeMap.get(intro.nodeId);
    const days = intro.dateRequested
      ? Math.floor((today - new Date(intro.dateRequested).getTime()) / 86400000)
      : null;
    let bucket: 'too-fresh' | 'polite' | 'close-loop' = 'too-fresh';
    if (days !== null) {
      if (days >= CLOSE_LOOP_DAYS) bucket = 'close-loop';
      else if (days >= FOLLOWUP_GAP_DAYS) bucket = 'polite';
    }

    // Same eligibility logic the cron uses:
    //   - haven't hit the 2-bump cap
    //   - intro is at least 7 days old
    //   - last bump (if any) was at least 7 days ago
    const fc = intro.followupCount ?? 0;
    let canDraftBump = true;
    let bumpBlockedReason: 'capped' | 'too-fresh' | 'cooldown' | null = null;
    let daysUntilNextBump: number | null = null;
    if (fc >= MAX_FOLLOWUPS) {
      canDraftBump = false;
      bumpBlockedReason = 'capped';
    } else if (days === null || days < FOLLOWUP_GAP_DAYS) {
      canDraftBump = false;
      bumpBlockedReason = 'too-fresh';
      daysUntilNextBump = days === null ? null : FOLLOWUP_GAP_DAYS - days;
    } else if (intro.lastFollowupAt) {
      const daysSinceLast = Math.floor((today - new Date(intro.lastFollowupAt).getTime()) / 86400000);
      if (daysSinceLast < FOLLOWUP_GAP_DAYS) {
        canDraftBump = false;
        bumpBlockedReason = 'cooldown';
        daysUntilNextBump = FOLLOWUP_GAP_DAYS - daysSinceLast;
      }
    }

    return {
      introId: intro.id,
      founderId: intro.founderId,
      founderName: found?.name || 'Unknown',
      companyName: found?.companyName || '',
      investorId: intro.investorId,
      investorName: inv?.name || 'Unknown',
      investorFirm: inv?.firm ?? null,
      investorEmail: inv?.email ?? null,
      nodeId: intro.nodeId,
      nodeName: node?.name ?? null,
      dateRequested: intro.dateRequested,
      daysSinceRequested: days,
      followupCount: fc,
      lastFollowupAt: intro.lastFollowupAt,
      bucket,
      templatePreview: pickFollowupTemplate(intro.dateRequested),
      canDraftBump,
      bumpBlockedReason,
      daysUntilNextBump,
      gmailThreadId: intro.gmailThreadId,
    };
  });

  // Oldest first — that's the action order the admin wants.
  rows.sort((a, b) => {
    const ad = a.daysSinceRequested ?? -1;
    const bd = b.daysSinceRequested ?? -1;
    return bd - ad;
  });

  return { rows };
}

// Draft a single follow-up bump for one intro. Picks the template by age,
// reuses the same Gmail thread, increments followupCount. Returns the
// drafted Gmail link so the UI can shortcut the admin straight to it.
export async function draftFollowupForIntro(introId: number): Promise<{
  ok: boolean;
  error?: string;
  introId: number;
  bucket?: 'polite' | 'close-loop' | 'too-fresh';
  followupCount?: number;
  gmailUrl?: string;
}> {
  const gmail = await getGmailStatus();
  if (!gmail.connected) {
    return { ok: false, introId, error: 'Gmail not connected' };
  }

  const intro = await db.query.introRequests.findFirst({ where: eq(introRequests.id, introId) });
  if (!intro) return { ok: false, introId, error: 'intro not found' };
  if (intro.status !== 'intro_request_sent') {
    return { ok: false, introId, error: `intro status is ${intro.status}, not intro_request_sent` };
  }
  if (intro.replyDetectedAt) {
    return { ok: false, introId, error: 'reply already detected — clear with Recheck replies if it was a false positive' };
  }
  if ((intro.followupCount ?? 0) >= MAX_FOLLOWUPS) {
    return { ok: false, introId, error: `at max follow-ups (${MAX_FOLLOWUPS})` };
  }
  // Cooldown: same gap rule the cron uses. Don't allow a second bump within
  // FOLLOWUP_GAP_DAYS of the previous one, or within FOLLOWUP_GAP_DAYS of the
  // original send.
  const today = Date.now();
  if (intro.dateRequested) {
    const daysSinceRequested = Math.floor((today - new Date(intro.dateRequested).getTime()) / 86400000);
    if (daysSinceRequested < FOLLOWUP_GAP_DAYS) {
      return { ok: false, introId, error: `intro is only ${daysSinceRequested}d old — wait ${FOLLOWUP_GAP_DAYS - daysSinceRequested}d` };
    }
  }
  if (intro.lastFollowupAt) {
    const daysSinceLast = Math.floor((today - new Date(intro.lastFollowupAt).getTime()) / 86400000);
    if (daysSinceLast < FOLLOWUP_GAP_DAYS) {
      return { ok: false, introId, error: `last bump was ${daysSinceLast}d ago — wait ${FOLLOWUP_GAP_DAYS - daysSinceLast}d` };
    }
  }
  if (!intro.gmailThreadId) {
    return { ok: false, introId, error: 'no gmail thread id on this intro' };
  }

  const [investor, founder] = await Promise.all([
    db.query.investors.findFirst({ where: eq(investors.id, intro.investorId) }),
    db.query.founders.findFirst({ where: eq(founders.id, intro.founderId) }),
  ]);
  if (!investor || !investor.email) return { ok: false, introId, error: 'no investor email' };
  if (!founder) return { ok: false, introId, error: 'no founder record' };

  const investorFirst = (investor.name || '').split(/\s+/)[0] || 'there';
  const template = pickFollowupTemplate(intro.dateRequested);
  const body = template.replace(/\{\{first\}\}/g, investorFirst);
  const originalSubject = founder.companyName || founder.name;
  const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;

  const bucket: 'polite' | 'close-loop' | 'too-fresh' = (() => {
    if (!intro.dateRequested) return 'polite';
    const days = Math.floor((Date.now() - new Date(intro.dateRequested).getTime()) / 86400000);
    if (days >= CLOSE_LOOP_DAYS) return 'close-loop';
    if (days >= FOLLOWUP_GAP_DAYS) return 'polite';
    return 'too-fresh';
  })();

  try {
    const sent = await sendThreadReply({
      threadId: intro.gmailThreadId,
      to: investor.email,
      subject,
      body,
      asDraft: true,
    });
    const now = new Date().toISOString();
    await db.update(introRequests).set({
      followupCount: (intro.followupCount ?? 0) + 1,
      lastFollowupAt: now,
      updatedAt: now,
    }).where(eq(introRequests.id, intro.id));
    const draftId = (sent as any).draftId as string | undefined;
    return {
      ok: true,
      introId,
      bucket,
      followupCount: (intro.followupCount ?? 0) + 1,
      gmailUrl: draftId ? `https://mail.google.com/mail/u/0/#drafts/${draftId}` : undefined,
    };
  } catch (e: any) {
    return { ok: false, introId, error: `draft failed: ${e.message || e}` };
  }
}

// One-shot: re-evaluate every intro currently marked replyDetectedAt and
// clear the flag for those where the *investor* never actually replied. Used
// to recover from the pre-fix false positives (a node forwarding/replying
// inside the thread used to count as the investor responding).
export async function recheckReplyDetections(): Promise<{
  checked: number;
  cleared: number;
  kept: number;
  skipped: number;
  rows: Array<{ introId: number; investorName: string; investorEmail: string | null; action: 'cleared' | 'kept' | 'skipped'; detail?: string }>;
}> {
  const gmail = await getGmailStatus();
  if (!gmail.connected) {
    return { checked: 0, cleared: 0, kept: 0, skipped: 0, rows: [] };
  }

  const flagged = await db.select().from(introRequests)
    .where(and(
      sql`${introRequests.replyDetectedAt} IS NOT NULL`,
      sql`${introRequests.gmailThreadId} IS NOT NULL AND ${introRequests.gmailThreadId} != ''`,
    ));

  let cleared = 0, kept = 0, skipped = 0;
  const rows: Array<{ introId: number; investorName: string; investorEmail: string | null; action: 'cleared' | 'kept' | 'skipped'; detail?: string }> = [];

  for (const intro of flagged) {
    const investor = await db.query.investors.findFirst({ where: eq(investors.id, intro.investorId) });
    if (!investor) {
      skipped++;
      rows.push({ introId: intro.id, investorName: 'Unknown', investorEmail: null, action: 'skipped', detail: 'investor not found' });
      continue;
    }
    if (!investor.email) {
      // Can't scope without an email; leave the flag alone rather than guess.
      skipped++;
      rows.push({ introId: intro.id, investorName: investor.name, investorEmail: null, action: 'skipped', detail: 'no investor email — flag left as-is' });
      continue;
    }
    try {
      const info = await checkThreadReplies(intro.gmailThreadId!, investor.email);
      if (info.hasReply) {
        kept++;
        rows.push({ introId: intro.id, investorName: investor.name, investorEmail: investor.email, action: 'kept' });
      } else {
        await db.update(introRequests)
          .set({ replyDetectedAt: null, updatedAt: new Date().toISOString() })
          .where(eq(introRequests.id, intro.id));
        cleared++;
        rows.push({ introId: intro.id, investorName: investor.name, investorEmail: investor.email, action: 'cleared' });
      }
    } catch (e: any) {
      skipped++;
      rows.push({ introId: intro.id, investorName: investor.name, investorEmail: investor.email, action: 'skipped', detail: `thread check failed: ${e.message || e}` });
    }
  }

  return { checked: flagged.length, cleared, kept, skipped, rows };
}
