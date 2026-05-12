import { eq, inArray } from 'drizzle-orm';
import { db, founders, investors, nodes, matchSuggestions, type MatchSuggestion } from '../db/index.js';
import { generateMatchSuggestions } from './matching.js';
import { sendEmail } from './email.js';

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
}> {
  const baseUrl = process.env.BASE_URL || 'https://matcap.vc';
  const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';

  // 1. Generate fresh suggestions across all eligible founders.
  // generateMatchSuggestions persists rows in match_suggestions with
  // status='pending' for each new candidate.
  const { suggestions, batchId } = await generateMatchSuggestions();

  // 2. Pull the just-created pending suggestions back (with the new batchId)
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

  return {
    generated: suggestions.length,
    topRecommendations: top.length,
    emailSent,
    recipient: adminEmail,
  };
}
