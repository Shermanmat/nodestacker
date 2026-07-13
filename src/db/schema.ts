import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

// Enums as const objects
export const CompanyStage = {
  IDEA: 'idea',
  PRE_SEED: 'pre_seed',
  SEED: 'seed',
  SERIES_A: 'series_a',
} as const;

export const RoundStatus = {
  PRE_ROUND: 'pre_round',
  ROUND_OPEN: 'round_open',
  ROUND_CLOSED: 'round_closed',
} as const;

export const RelationshipStrength = {
  STRONG: 'strong',
  MEDIUM: 'medium',
  WEAK: 'weak',
} as const;

export const AddedBy = {
  PLATFORM: 'platform',
  ADMIN: 'admin',
  FOUNDER: 'founder',
} as const;

export const IntroStatus = {
  PENDING_SUGGESTION: 'pending_suggestion',
  INTRO_REQUEST_SENT: 'intro_request_sent',
  INTRODUCED: 'introduced',
  PASSED: 'passed',
  IGNORED: 'ignored',
  FIRST_MEETING_COMPLETE: 'first_meeting_complete',
  SECOND_MEETING_COMPLETE: 'second_meeting_complete',
  FOLLOW_UP_QUESTIONS: 'follow_up_questions',
  CIRCLE_BACK_ROUND_OPENS: 'circle_back_round_opens',
  INVESTED: 'invested',
} as const;

export const FollowupOwner = {
  FOUNDER: 'founder',
  ADMIN: 'admin',
} as const;

export const FollowupType = {
  NODE_CHECK: 'node_check',
  MEETING_UPDATE: 'meeting_update',
  NODE_UPDATE: 'node_update',
} as const;

// Core Tables

export const founders = sqliteTable('founders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  companyName: text('company_name').notNull(),
  companyStage: text('company_stage').notNull(),
  roundStatus: text('round_status').notNull().default('pre_round'),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  city: text('city'),
  country: text('country'),
  introTargetPerWeek: integer('intro_target_per_week').default(2),
  introCadenceActive: integer('intro_cadence_active', { mode: 'boolean' }).default(false),
  // Soft preference: when true, the matching algorithm gives a +20 score
  // bonus to angels (firm in NON_FIRM_NAMES or null) so they rank above
  // institutional VCs of equivalent base score. VCs still get suggested.
  preferAnglesOnly: integer('prefer_angels_only', { mode: 'boolean' }).default(false),
  cadenceStartDate: text('cadence_start_date'),
  // Treadmill calibration: a new founder's first ~10 intro requests go out as a
  // burst to learn their accept rate ("heat"). Once enough have resolved, their
  // ongoing weekly allowance is set from that rate and this is stamped. NULL =
  // still calibrating; existing founders are grandfathered (stamped) on migrate.
  calibratedAt: text('calibrated_at'),
  // Bonus "shots on goal" — one-off extra intro requests earned via carrots
  // (gym session, updating meetings, adding outside investors), gated on ≥20%
  // acceptance and capped. Consumed by the generator on top of the weekly pace.
  bonusShots: integer('bonus_shots').notNull().default(0),
  bonusGymGranted: integer('bonus_gym_granted').notNull().default(0),
  bonusMeetingsGranted: integer('bonus_meetings_granted').notNull().default(0),
  bonusInvestorsGranted: integer('bonus_investors_granted').notNull().default(0),
  // Win-blitz: when a founder lands a lead, Mat flips them into a sprint to
  // close the round. While blitzUntil is in the future, pace = blitzTarget and
  // the acceptance-based recompute leaves them alone.
  blitzUntil: text('blitz_until'),
  blitzTarget: integer('blitz_target'),
  // Intro draft content — used by the agent + manual approve flow to assemble
  // a final-shaped intro email instead of a skeleton.
  blurb: text('blurb'),
  deckUrl: text('deck_url'),
  deckFile: text('deck_file'), // server-stored filename, e.g. '<token>.pdf' — used for Gmail attachments
  calendlyUrl: text('calendly_url'),
  // Pitch Gym: how many practice reps this founder is allowed against the AI VC
  // personas. Default 1; admin can raise it or reset a founder for another rep.
  gymRepsAllowed: integer('gym_reps_allowed').notNull().default(1),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const nodes = sqliteTable('nodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  company: text('company'),
  role: text('role'),
  geography: text('geography'),
  notes: text('notes'),
  vip: integer('vip', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const investors = sqliteTable('investors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  firm: text('firm'),
  role: text('role'),
  email: text('email'),
  focusAreas: text('focus_areas'), // JSON array stored as text
  checkSize: text('check_size'),
  geography: text('geography'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  vip: integer('vip', { mode: 'boolean' }).notNull().default(false),
  pausedUntil: text('paused_until'), // ISO date — investor paused (e.g. raising fund)
  pauseReason: text('pause_reason'),
  city: text('city'),
  state: text('state'), // 2-char US state code (e.g. "CA"). Inferred from city via us-states map at row create / backfill; admin can override on the investor edit form.
  country: text('country'),
  notes: text('notes'), // Free-form admin notes — non-categorical quirks ("doesn't take cold intros", "asks for revenue first")
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// Relationship Tables

export const founderNodeRelationships = sqliteTable('founder_node_relationships', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull().references(() => founders.id),
  nodeId: integer('node_id').notNull().references(() => nodes.id),
  relationshipStrength: text('relationship_strength').notNull().default('medium'),
  howConnected: text('how_connected'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const nodeInvestorConnections = sqliteTable('node_investor_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: integer('node_id').notNull().references(() => nodes.id),
  investorId: integer('investor_id').notNull().references(() => investors.id),
  connectionStrength: text('connection_strength').notNull().default('medium'),
  addedBy: text('added_by').notNull().default('admin'),
  validated: integer('validated', { mode: 'boolean' }).notNull().default(false),
  lastIntroDate: text('last_intro_date'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// Workflow Tables

export const introRequests = sqliteTable('intro_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull().references(() => founders.id),
  nodeId: integer('node_id').notNull().references(() => nodes.id),
  investorId: integer('investor_id').notNull().references(() => investors.id),
  status: text('status').notNull().default('intro_request_sent'),
  dateRequested: text('date_requested'),
  dateNodeAsked: text('date_node_asked'),
  dateIntroduced: text('date_introduced'),
  firstMeetingDate: text('first_meeting_date'),
  secondMeetingDate: text('second_meeting_date'),
  nextFollowupDate: text('next_followup_date'),
  lastFollowupDate: text('last_followup_date'),
  followupOwner: text('followup_owner').default('founder'),
  datePassed: text('date_passed'),
  passReason: text('pass_reason'),
  // Partner handoff: when a VC passes the deal to a colleague who takes the
  // meeting, the intro is reassigned to that colleague (investorId) and the
  // original partner is recorded here so we keep "handed off from X".
  handedOffFromInvestorId: integer('handed_off_from_investor_id').references(() => investors.id),
  handedOffAt: text('handed_off_at'),
  investorBumpCount: integer('investor_bump_count').notNull().default(0),
  lastInvestorBumpAt: text('last_investor_bump_at'),
  // Gmail draft id created by the auto-draft agent. Presence = draft exists
  // in user's Gmail, awaiting their review/send. Status stays pending_suggestion
  // until the user marks it sent.
  gmailDraftId: text('gmail_draft_id'),
  gmailDraftCreatedAt: text('gmail_draft_created_at'),
  // Captured when the intro is actually sent via sendGmail. Lets the
  // follow-up agent fetch the thread state to check for replies and
  // create follow-up drafts in the same thread.
  gmailThreadId: text('gmail_thread_id'),
  // Reply detection: set when checkThreadReplies finds a message from
  // someone other than us in the thread. Stops the follow-up agent
  // from bumping investors who've already responded.
  replyDetectedAt: text('reply_detected_at'),
  // Reply classifier (Phase 1 autonomous agent) — written by runReplyClassifierTick.
  // Classification is one of: yes / no / not_now / needs_human / out_of_office / wrong_person.
  // For no & not_now we ALSO write the short reason into passReason so it shows up in
  // the admin's existing reports — this column is the structured machine label.
  replyClassification: text('reply_classification'),
  replyClassificationAt: text('reply_classification_at'),
  replyClassificationConfidence: text('reply_classification_confidence'), // stored as string so we don't fight sqlite's REAL gotchas
  replyBodySnippet: text('reply_body_snippet'), // first ~500 chars of what we classified, for audit
  // Gmail draft id for the founder↔investor intro auto-generated on a "yes".
  introHandoffDraftId: text('intro_handoff_draft_id'),
  introHandoffDraftCreatedAt: text('intro_handoff_draft_created_at'),
  // Auto-send tracking (Phase 2). When classifier auto-sends the handoff
  // reply instead of just drafting it, these record the send + the gmail
  // message id. autoSent stays false for human-clicks-send cases.
  introHandoffSentAt: text('intro_handoff_sent_at'),
  introHandoffAutoSent: integer('intro_handoff_auto_sent', { mode: 'boolean' }).default(false),
  introHandoffMessageId: text('intro_handoff_message_id'),
  // When MatCap auto-replied "thanks!" + archived a pass. Lets the backfill skip
  // passes already acknowledged (idempotent re-runs).
  passAutoRepliedAt: text('pass_auto_replied_at'),
  // Follow-up tracking
  followupCount: integer('followup_count').notNull().default(0),
  lastFollowupAt: text('last_followup_at'),
  notes: text('notes'),
  // Founder-side CRM fields. Separate from admin-side `notes` so a founder
  // can keep their own diligence notes / next-action without polluting the
  // admin view (and vice versa).
  founderNextActionText: text('founder_next_action_text'),
  founderNextActionDate: text('founder_next_action_date'),
  founderCheckSize: text('founder_check_size'),
  founderOwnedNotes: text('founder_owned_notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

// Founder-private investor records — investors a founder is tracking that
// are NOT in MatCap's network. Admin does NOT see these. The founder CRM
// page unions these with the founder's intro_requests for a single view.
export const founderInvestorRecords = sqliteTable('founder_investor_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull().references(() => founders.id),
  name: text('name').notNull(),
  firm: text('firm'),
  role: text('role'),
  email: text('email'),
  geography: text('geography'),
  // 'self_added' = founder reached out; 'cold_inbound' = investor reached out;
  // 'warm_intro' = someone connected them (connector in warm_intro_connector)
  source: text('source').notNull().default('self_added'),
  status: text('status').notNull().default('self_outreach'),
  nextActionText: text('next_action_text'),
  nextActionDate: text('next_action_date'),
  checkSize: text('check_size'),
  notes: text('notes'),
  // For source='warm_intro': who connected the founder to this investor (optional)
  warmIntroConnector: text('warm_intro_connector'),
  // Soft delete — set when archived (via portal or MCP). Archived rows drop out
  // of the pipeline view but are never hard-deleted, so archiving is reversible.
  archivedAt: text('archived_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

// Interaction log entries — works for both MatCap-sourced intros (via
// investorId) and founder-private records (via founderInvestorRecordId).
// Exactly one of the two fk columns is non-null on a given row.
export const investorInteractions = sqliteTable('investor_interactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull().references(() => founders.id),
  investorId: integer('investor_id').references(() => investors.id),
  founderInvestorRecordId: integer('founder_investor_record_id').references(() => founderInvestorRecords.id),
  // 'meeting' | 'email' | 'call' | 'note' | 'intro_sent'
  interactionType: text('interaction_type').notNull(),
  occurredAt: text('occurred_at').notNull(),
  content: text('content'),
  // 'founder' | 'matcap_admin' — who logged this entry
  createdBy: text('created_by').notNull().default('founder'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type FounderInvestorRecord = typeof founderInvestorRecords.$inferSelect;
export type NewFounderInvestorRecord = typeof founderInvestorRecords.$inferInsert;
export type InvestorInteraction = typeof investorInteractions.$inferSelect;
export type NewInvestorInteraction = typeof investorInteractions.$inferInsert;

export const followupLogs = sqliteTable('followup_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  introRequestId: integer('intro_request_id').notNull().references(() => introRequests.id),
  followupType: text('followup_type').notNull(),
  completedBy: text('completed_by').notNull(),
  completedAt: text('completed_at').notNull(),
  notes: text('notes'),
  nextAction: text('next_action'),
});

// Relations

export const foundersRelations = relations(founders, ({ many }) => ({
  nodeRelationships: many(founderNodeRelationships),
  introRequests: many(introRequests),
  categoryAssignments: many(founderCategoryAssignments),
}));

export const nodesRelations = relations(nodes, ({ many }) => ({
  founderRelationships: many(founderNodeRelationships),
  investorConnections: many(nodeInvestorConnections),
  introRequests: many(introRequests),
}));

export const investorsRelations = relations(investors, ({ many }) => ({
  nodeConnections: many(nodeInvestorConnections),
  introRequests: many(introRequests),
  research: many(investorResearch),
  categoryAssignments: many(investorCategoryAssignments),
  categoryExclusions: many(investorCategoryExclusions),
}));

export const founderNodeRelationshipsRelations = relations(founderNodeRelationships, ({ one }) => ({
  founder: one(founders, {
    fields: [founderNodeRelationships.founderId],
    references: [founders.id],
  }),
  node: one(nodes, {
    fields: [founderNodeRelationships.nodeId],
    references: [nodes.id],
  }),
}));

export const nodeInvestorConnectionsRelations = relations(nodeInvestorConnections, ({ one }) => ({
  node: one(nodes, {
    fields: [nodeInvestorConnections.nodeId],
    references: [nodes.id],
  }),
  investor: one(investors, {
    fields: [nodeInvestorConnections.investorId],
    references: [investors.id],
  }),
}));

export const introRequestsRelations = relations(introRequests, ({ one, many }) => ({
  founder: one(founders, {
    fields: [introRequests.founderId],
    references: [founders.id],
  }),
  node: one(nodes, {
    fields: [introRequests.nodeId],
    references: [nodes.id],
  }),
  investor: one(investors, {
    fields: [introRequests.investorId],
    references: [investors.id],
  }),
  followupLogs: many(followupLogs),
}));

export const followupLogsRelations = relations(followupLogs, ({ one }) => ({
  introRequest: one(introRequests, {
    fields: [followupLogs.introRequestId],
    references: [introRequests.id],
  }),
}));

// Portfolio Companies Table
export const portfolioCompanies = sqliteTable('portfolio_companies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull().references(() => founders.id).unique(),
  oneLiner: text('one_liner'), // brief description of the company
  investmentDate: text('investment_date'),
  equityPercent: text('equity_percent'), // stored as text to handle decimals like "0.5%"
  currentValuation: integer('current_valuation'), // in dollars (latest known)
  entryValuation: integer('entry_valuation'), // valuation MatCap got its equity at — markup baseline
  advisorySigned: integer('advisory_signed', { mode: 'boolean' }).notNull().default(false),
  equitySigned: integer('equity_signed', { mode: 'boolean' }).notNull().default(false),
  sharesPaid: integer('shares_paid', { mode: 'boolean' }).notNull().default(false),
  certificateReceived: integer('certificate_received', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const portfolioCompaniesRelations = relations(portfolioCompanies, ({ one }) => ({
  founder: one(founders, {
    fields: [portfolioCompanies.founderId],
    references: [founders.id],
  }),
}));

// Funding events on a portfolio company — each time an investor invests at a
// valuation. Drives the markup (latest valuation vs. MatCap's entry valuation).
export const portfolioRounds = sqliteTable('portfolio_rounds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  portfolioCompanyId: integer('portfolio_company_id').notNull().references(() => portfolioCompanies.id),
  roundDate: text('round_date'),          // ISO date
  roundName: text('round_name'),          // e.g. "Seed", "Pre-seed extension"
  investorName: text('investor_name'),    // lead/notable investor
  amountInvested: integer('amount_invested'), // dollars raised (optional)
  valuation: integer('valuation'),        // post-money valuation in dollars
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type PortfolioRound = typeof portfolioRounds.$inferSelect;
export type NewPortfolioRound = typeof portfolioRounds.$inferInsert;

// Trials — the 2-week, no-equity audition between "applied" and "portfolio".
// MatCap makes 5–15 intros, then decides offer (1%) or pass; the founder then
// accepts or declines. Auto metrics (intros/replies/CRM activity) are computed
// live from intro_requests + founder CRM tables; only the human-judgment
// ratings are stored here.
export const trials = sqliteTable('trials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull().references(() => founders.id),
  // 'active' | 'offer_made' | 'passed' | 'offer_accepted' | 'offer_declined' | 'expired'
  status: text('status').notNull().default('active'),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  introTargetMin: integer('intro_target_min').notNull().default(5),
  introTargetMax: integer('intro_target_max').notNull().default(15),
  offerEquityPercent: text('offer_equity_percent').notNull().default('1'),
  // Decision (admin): offer or pass
  decision: text('decision'), // 'offer' | 'pass' | null
  decisionAt: text('decision_at'),
  decisionNotes: text('decision_notes'),
  // Founder response to an offer
  founderResponse: text('founder_response'), // 'accepted' | 'declined' | null
  founderRespondedAt: text('founder_responded_at'),
  // After a pass/decline, CRM stays read-only until this timestamp, then off.
  accessRevokesAt: text('access_revokes_at'),
  // Scorecard ratings (1–5, admin judgment). Auto metrics are NOT stored.
  scoreFounderActivity: integer('score_founder_activity'),
  scoreCommsQuality: integer('score_comms_quality'),
  scoreMindset: integer('score_mindset'),
  scoreInvestorSentiment: integer('score_investor_sentiment'),
  scoreFollowThrough: integer('score_follow_through'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const trialsRelations = relations(trials, ({ one }) => ({
  founder: one(founders, {
    fields: [trials.founderId],
    references: [founders.id],
  }),
}));

export type Trial = typeof trials.$inferSelect;
export type NewTrial = typeof trials.$inferInsert;

// Investor Research Table (AI-powered research)
export const investorResearch = sqliteTable('investor_research', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  investorId: integer('investor_id').notNull().references(() => investors.id),
  bio: text('bio'),
  investmentThesis: text('investment_thesis'),
  portfolioCompanies: text('portfolio_companies'), // JSON array
  founderPreferences: text('founder_preferences'),
  recentActivity: text('recent_activity'),
  sourceUrls: text('source_urls'), // JSON array
  status: text('status').notNull().default('pending'), // pending, in_progress, completed, failed
  errorMessage: text('error_message'),
  researchedAt: text('researched_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const investorResearchRelations = relations(investorResearch, ({ one }) => ({
  investor: one(investors, {
    fields: [investorResearch.investorId],
    references: [investors.id],
  }),
}));

// Category System (shared between investors and founders)

export const CategoryType = {
  STAGE: 'stage',
  PERSONA: 'persona',
  SECTOR: 'sector',
} as const;

export const investorCategories = sqliteTable('investor_categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  type: text('type').notNull().default('sector'),
  color: text('color').default('gray'),
  parentId: integer('parent_id'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const investorCategoryAssignments = sqliteTable('investor_category_assignments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  investorId: integer('investor_id').notNull().references(() => investors.id),
  categoryId: integer('category_id').notNull().references(() => investorCategories.id),
});

export const founderCategoryAssignments = sqliteTable('founder_category_assignments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull().references(() => founders.id),
  categoryId: integer('category_id').notNull().references(() => investorCategories.id),
});

export const investorCategoriesRelations = relations(investorCategories, ({ many }) => ({
  investorAssignments: many(investorCategoryAssignments),
  founderAssignments: many(founderCategoryAssignments),
}));

export const investorCategoryAssignmentsRelations = relations(investorCategoryAssignments, ({ one }) => ({
  investor: one(investors, {
    fields: [investorCategoryAssignments.investorId],
    references: [investors.id],
  }),
  category: one(investorCategories, {
    fields: [investorCategoryAssignments.categoryId],
    references: [investorCategories.id],
  }),
}));

export const founderCategoryAssignmentsRelations = relations(founderCategoryAssignments, ({ one }) => ({
  founder: one(founders, {
    fields: [founderCategoryAssignments.founderId],
    references: [founders.id],
  }),
  category: one(investorCategories, {
    fields: [founderCategoryAssignments.categoryId],
    references: [investorCategories.id],
  }),
}));

export type InvestorCategory = typeof investorCategories.$inferSelect;
export type NewInvestorCategory = typeof investorCategories.$inferInsert;
export type InvestorCategoryAssignment = typeof investorCategoryAssignments.$inferSelect;
export type FounderCategoryAssignment = typeof founderCategoryAssignments.$inferSelect;

// Type exports
export type Founder = typeof founders.$inferSelect;
export type NewFounder = typeof founders.$inferInsert;
export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type Investor = typeof investors.$inferSelect;
export type NewInvestor = typeof investors.$inferInsert;
export type FounderNodeRelationship = typeof founderNodeRelationships.$inferSelect;
export type NewFounderNodeRelationship = typeof founderNodeRelationships.$inferInsert;
export type NodeInvestorConnection = typeof nodeInvestorConnections.$inferSelect;
export type NewNodeInvestorConnection = typeof nodeInvestorConnections.$inferInsert;
export type IntroRequest = typeof introRequests.$inferSelect;
export type NewIntroRequest = typeof introRequests.$inferInsert;
export type FollowupLog = typeof followupLogs.$inferSelect;
export type NewFollowupLog = typeof followupLogs.$inferInsert;
export type InvestorResearch = typeof investorResearch.$inferSelect;
export type NewInvestorResearch = typeof investorResearch.$inferInsert;
export type PortfolioCompany = typeof portfolioCompanies.$inferSelect;
export type NewPortfolioCompany = typeof portfolioCompanies.$inferInsert;

// Admin Sessions Table (persistent admin login sessions)
export const adminSessions = sqliteTable('admin_sessions', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type AdminSession = typeof adminSessions.$inferSelect;
export type NewAdminSession = typeof adminSessions.$inferInsert;

// Founder portal sessions. Persisted (not in-memory) so logins survive server
// restarts and deploys — otherwise every deploy logs every founder out.
export const founderSessions = sqliteTable('founder_sessions', {
  id: text('id').primaryKey(),
  founderId: integer('founder_id').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type FounderSession = typeof founderSessions.$inferSelect;
export type NewFounderSession = typeof founderSessions.$inferInsert;

// Meeting transcripts (Granola etc.), ingested per-founder via the founder's own
// token, matched to a pipeline item and scored by an LLM. The transcript is the
// founder's data — we only ever ingest what they forward us.
export const meetingTranscripts = sqliteTable('meeting_transcripts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull(),
  source: text('source').notNull().default('granola'),
  meetingTitle: text('meeting_title'),
  transcript: text('transcript').notNull(),
  shareLink: text('share_link'),
  // Matching → which pipeline item (composite id "<kind>:<id>") this is about.
  matchedPipelineId: text('matched_pipeline_id'),
  matchedInvestorName: text('matched_investor_name'),
  matchStatus: text('match_status').notNull().default('pending'), // matched | unmatched | not_investor_meeting
  matchConfidence: text('match_confidence'),
  // Objective scoring
  meetingType: text('meeting_type'),     // first_meeting | follow_up | partner | diligence
  outcome: text('outcome'),              // advancing | soft_pass | hard_pass | wants_follow_up
  summary: text('summary'),
  nextStepText: text('next_step_text'),
  nextStepDate: text('next_step_date'),
  // Subjective scoring (1-5, advisory — never auto-decides)
  scoreCommsQuality: integer('score_comms_quality'),
  scoreInvestorSentiment: integer('score_investor_sentiment'),
  scoreFollowThrough: integer('score_follow_through'),
  scoreJson: text('score_json'),         // full LLM output, for audit
  // Lifecycle
  status: text('status').notNull().default('received'), // received | processed | needs_review | error
  appliedAt: text('applied_at'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  processedAt: text('processed_at'),
});

export type MeetingTranscript = typeof meetingTranscripts.$inferSelect;
export type NewMeetingTranscript = typeof meetingTranscripts.$inferInsert;

// Founder-requested changes to the production investor materials (blurb + deck).
// Founders never overwrite the live assets — they file a request here that the
// admin reviews and approves. Deck uploads are staged (proposedDeckFile) until
// approved.
export const commsChangeRequests = sqliteTable('comms_change_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull(),
  kind: text('kind').notNull(),                  // 'blurb' | 'deck'
  note: text('note'),                            // founder's context / requested change
  proposedDeckFile: text('proposed_deck_file'),  // staged deck filename (deck requests)
  approveToken: text('approve_token'),           // tokenized one-click approve link (emailed to admin)
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  resolvedAt: text('resolved_at'),
});

export type CommsChangeRequest = typeof commsChangeRequests.$inferSelect;
export type NewCommsChangeRequest = typeof commsChangeRequests.$inferInsert;

// Investor-discovery agent: candidates found on the open web (via Claude web
// search), pending admin review. Approve → creates an investors row.
export const investorCandidates = sqliteTable('investor_candidates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  firm: text('firm'),
  role: text('role'),
  stage: text('stage'),
  checkSize: text('check_size'),
  thesis: text('thesis'),
  geo: text('geo'),
  links: text('links'),              // JSON array of urls
  sourceUrl: text('source_url'),
  confidence: text('confidence'),    // 0-1 as string (sqlite REAL gotchas)
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  investorId: integer('investor_id'), // set when approved → the created investor
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  reviewedAt: text('reviewed_at'),
});

export type InvestorCandidate = typeof investorCandidates.$inferSelect;
export type NewInvestorCandidate = typeof investorCandidates.$inferInsert;

// Inbound Intro Logs Table (BCC email logging for intro tracking)
export const InboundIntroLogStatus = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DISMISSED: 'dismissed',
} as const;

export const inboundIntroLogs = sqliteTable('inbound_intro_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromEmail: text('from_email').notNull(),
  toEmails: text('to_emails').notNull(), // JSON array
  ccEmails: text('cc_emails'), // JSON array
  subject: text('subject'),
  bodyPreview: text('body_preview'), // First 500 chars
  detectedFounderId: integer('detected_founder_id').references(() => founders.id),
  detectedInvestorId: integer('detected_investor_id').references(() => investors.id),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  processedAt: text('processed_at'),
  emailDate: text('email_date'), // Original email date from Postmark
});

export const inboundIntroLogsRelations = relations(inboundIntroLogs, ({ one }) => ({
  founder: one(founders, {
    fields: [inboundIntroLogs.detectedFounderId],
    references: [founders.id],
  }),
  investor: one(investors, {
    fields: [inboundIntroLogs.detectedInvestorId],
    references: [investors.id],
  }),
}));

export type InboundIntroLog = typeof inboundIntroLogs.$inferSelect;
export type NewInboundIntroLog = typeof inboundIntroLogs.$inferInsert;

// Onboarding Workflow Tables

export const OnboardingStatus = {
  OFFER_PENDING: 'offer_pending',
  OFFER_ACCEPTED: 'offer_accepted',
  PENDING_INCORPORATION: 'pending_incorporation',
  LIGHT_ENGAGEMENT: 'light_engagement',
  // Docs-first track: already-incorporated companies upload formation docs
  // (AOC + bylaws + initial board consent), we extract variables, founder
  // confirms, then it rejoins the flow at ENTITY_INFO_RECEIVED.
  DOCS_PENDING: 'docs_pending',
  DOCS_UPLOADED: 'docs_uploaded',
  DOCS_EXTRACTED: 'docs_extracted',
  ENTITY_INFO_PENDING: 'entity_info_pending',
  ENTITY_INFO_RECEIVED: 'entity_info_received',
  ADVISORY_AGREEMENT_SENT: 'advisory_agreement_sent',
  ADMIN_SIGNED: 'admin_signed',
  FOUNDER_SIGNED: 'founder_signed',
  BOARD_APPROVAL_PENDING: 'board_approval_pending',
  BOARD_APPROVED: 'board_approved',
  EQUITY_AGREEMENT_PENDING: 'equity_agreement_pending',
  EQUITY_FOUNDER_SIGNED: 'equity_founder_signed',
  EQUITY_ADMIN_SIGNED: 'equity_admin_signed',
  EQUITY_AGREEMENT_SIGNED: 'equity_agreement_signed',
  WIRE_INFO_PENDING: 'wire_info_pending',
  SHARES_PURCHASED: 'shares_purchased',
  ELECTION_83B_FILED: '83b_filed',
  CERTIFICATE_PENDING: 'certificate_pending',
  COMPLETED: 'completed',
} as const;

export const OnboardingEventType = {
  WORKFLOW_STARTED: 'workflow_started',
  OFFER_SENT: 'offer_sent',
  OFFER_ACCEPTED: 'offer_accepted',
  ENTITY_INFO_SUBMITTED: 'entity_info_submitted',
  ADVISORY_AGREEMENT_CREATED: 'advisory_agreement_created',
  ADVISORY_AGREEMENT_SENT: 'advisory_agreement_sent',
  ADMIN_SIGNED_ADVISORY: 'admin_signed_advisory',
  FOUNDER_SIGNED_ADVISORY: 'founder_signed_advisory',
  BOARD_APPROVAL_REQUESTED: 'board_approval_requested',
  BOARD_MEMBER_APPROVED: 'board_member_approved',
  BOARD_APPROVAL_COMPLETE: 'board_approval_complete',
  EQUITY_AGREEMENT_UPLOADED: 'equity_agreement_uploaded',
  EQUITY_FOUNDER_SIGNED: 'equity_founder_signed',
  EQUITY_ADMIN_SIGNED: 'equity_admin_signed',
  EQUITY_AGREEMENT_SIGNED: 'equity_agreement_signed',
  WIRE_INFO_SUBMITTED: 'wire_info_submitted',
  SHARES_PURCHASED: 'shares_purchased',
  ELECTION_83B_FILED: '83b_filed',
  CERTIFICATE_UPLOADED: 'certificate_uploaded',
  CERTIFICATE_VERIFIED: 'certificate_verified',
  WORKFLOW_COMPLETED: 'workflow_completed',
  INCORPORATION_ANSWERED: 'incorporation_answered',
  EQUITY_COMMITMENT_SIGNED: 'equity_commitment_signed',
  INCORPORATION_CONFIRMED: 'incorporation_confirmed',
  INCORPORATION_NUDGE_SENT: 'incorporation_nudge_sent',
  REMINDER_SENT: 'reminder_sent',
  WEBHOOK_RECEIVED: 'webhook_received',
  DOCUMENT_UPLOADED: 'document_uploaded',
  // Docs-first track
  FORMATION_DOCS_UPLOADED: 'formation_docs_uploaded',
  FORMATION_DOCS_EXTRACTED: 'formation_docs_extracted',
  FORMATION_DOCS_CONFIRMED: 'formation_docs_confirmed',
} as const;

export const OnboardingActor = {
  ADMIN: 'admin',
  FOUNDER: 'founder',
  SYSTEM: 'system',
  WEBHOOK: 'webhook',
} as const;

export const onboardingWorkflows = sqliteTable('onboarding_workflows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  portfolioCompanyId: integer('portfolio_company_id').notNull().references(() => portfolioCompanies.id).unique(),
  status: text('status').notNull().default('offer_pending'),

  // Intake type: 'form_new' (default flow) or 'docs_first' (already
  // incorporated — uploads formation docs we extract variables from).
  intakeType: text('intake_type').default('form_new'),

  // Docs-first intake: uploaded formation documents + AI extraction
  bylawsUrl: text('bylaws_url'),
  boardConsentUrl: text('board_consent_url'),
  incorporationDate: text('incorporation_date'),
  extractionRaw: text('extraction_raw'), // JSON: full Claude extraction result
  extractedAt: text('extracted_at'),
  docsConfirmedAt: text('docs_confirmed_at'),

  // Incorporation check
  incorporated: integer('incorporated', { mode: 'boolean' }),
  incorporationPartner: text('incorporation_partner'),
  approvedForLawFirm: integer('approved_for_law_firm', { mode: 'boolean' }).default(false),
  equityCommitmentSignedAt: text('equity_commitment_signed_at'),
  lastIncorporationNudgeAt: text('last_incorporation_nudge_at'),

  // Offer details
  offerEquityPercent: text('offer_equity_percent'),
  offerNotes: text('offer_notes'),
  offerSentAt: text('offer_sent_at'),
  offerAcceptedAt: text('offer_accepted_at'),

  // Intro request terms
  introRequestsPerWeek: integer('intro_requests_per_week').default(3),
  introRequestsRevisitDate: text('intro_requests_revisit_date'),

  // Vesting schedule
  vestingMonths: integer('vesting_months').default(48),
  vestingCliffMonths: integer('vesting_cliff_months').default(0),
  vestingStartDate: text('vesting_start_date'),

  // Entity info (from founder)
  entityName: text('entity_name'),
  entityType: text('entity_type'),
  entityState: text('entity_state'),
  ein: text('ein'),
  articlesOfIncorporationUrl: text('articles_of_incorporation_url'),
  authorizedShares: integer('authorized_shares'),
  sharePrice: text('share_price').default('0.0001'),
  founderTitle: text('founder_title'),
  entityInfoReceivedAt: text('entity_info_received_at'),

  // E-signature tracking (advisory agreement)
  esignDocumentId: text('esign_document_id'),
  esignSignatureRequestId: text('esign_signature_request_id'),
  agreementSentAt: text('agreement_sent_at'),
  founderSignedAt: text('founder_signed_at'),
  adminSignedAt: text('admin_signed_at'),
  signedDocumentUrl: text('signed_document_url'),

  // Equity purchase agreement (e-signed via Dropbox Sign)
  equityAgreementReceivedAt: text('equity_agreement_received_at'),
  equityAgreementUrl: text('equity_agreement_url'),
  equityFounderSignedAt: text('equity_founder_signed_at'),
  equityAdminSignedAt: text('equity_admin_signed_at'),
  equityAgreementSignedAt: text('equity_agreement_signed_at'),

  // Wire info (founder provides for share purchase)
  wireInfoUrl: text('wire_info_url'),

  // Share purchase
  sharePurchaseAmount: text('share_purchase_amount'),
  sharePurchaseDate: text('share_purchase_date'),
  sharePurchaseMethod: text('share_purchase_method'),

  // 83(b) election
  election83bFiledAt: text('election_83b_filed_at'),
  election83bProofUrl: text('election_83b_proof_url'),

  // Stock certificate (founder issues to MatCap)
  certificateReceivedAt: text('certificate_received_at'),
  certificateUrl: text('certificate_url'),
  certificateNumber: text('certificate_number'),
  equityVerifiedAt: text('equity_verified_at'),

  // Board approval
  boardApprovalRequestedAt: text('board_approval_requested_at'),
  boardApprovedAt: text('board_approved_at'),

  // Google Drive
  driveFolderId: text('drive_folder_id'),
  driveFolderUrl: text('drive_folder_url'),

  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const onboardingEvents = sqliteTable('onboarding_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: integer('workflow_id').notNull().references(() => onboardingWorkflows.id),
  eventType: text('event_type').notNull(),
  actor: text('actor').notNull(),
  actorEmail: text('actor_email'),
  details: text('details'), // JSON
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const boardMembers = sqliteTable('board_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: integer('workflow_id').notNull().references(() => onboardingWorkflows.id),
  name: text('name').notNull(),
  email: text('email').notNull(),
  title: text('title'),
  isFounder: integer('is_founder', { mode: 'boolean' }).notNull().default(false),
  // 'manual' (typed by founder) or 'extracted' (pulled from board consent doc)
  source: text('source').default('manual'),
  approvedAt: text('approved_at'),
  approvalIp: text('approval_ip'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// Onboarding Relations
export const onboardingWorkflowsRelations = relations(onboardingWorkflows, ({ one, many }) => ({
  portfolioCompany: one(portfolioCompanies, {
    fields: [onboardingWorkflows.portfolioCompanyId],
    references: [portfolioCompanies.id],
  }),
  events: many(onboardingEvents),
  boardMembers: many(boardMembers),
}));

export const onboardingEventsRelations = relations(onboardingEvents, ({ one }) => ({
  workflow: one(onboardingWorkflows, {
    fields: [onboardingEvents.workflowId],
    references: [onboardingWorkflows.id],
  }),
}));

export const boardMembersRelations = relations(boardMembers, ({ one }) => ({
  workflow: one(onboardingWorkflows, {
    fields: [boardMembers.workflowId],
    references: [onboardingWorkflows.id],
  }),
}));

export type OnboardingWorkflow = typeof onboardingWorkflows.$inferSelect;
export type NewOnboardingWorkflow = typeof onboardingWorkflows.$inferInsert;
export type OnboardingEvent = typeof onboardingEvents.$inferSelect;
export type NewOnboardingEvent = typeof onboardingEvents.$inferInsert;
export type BoardMember = typeof boardMembers.$inferSelect;
export type NewBoardMember = typeof boardMembers.$inferInsert;

// Founder Leads Tables (conversational onboarding)

export const FounderLeadStatus = {
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CONVERTED: 'converted',
} as const;

export const FounderPersona = {
  HIGH_SLOPE_BUILDER: 'high_slope_builder',
  EXPERIENCED_OPERATOR: 'experienced_operator',
  BUSINESS_ORIENTED_CODER: 'business_oriented_coder',
  LARGE_COMPANY_SPINOUT: 'large_company_spinout',
  STARTUP_INSIDER_FIRST_TIME: 'startup_insider_first_time',
  SCRAPPY_BOOTSTRAPPED: 'scrappy_bootstrapped',
  DOMAIN_EXPERT: 'domain_expert',
} as const;

export const FundraisingExperience = {
  RAISED_VENTURE: 'raised_venture',
  WORKED_AT_VENTURE_BACKED: 'worked_at_venture_backed',
  ATTEMPTED_RAISE: 'attempted_raise',
  NEVER_ATTEMPTED: 'never_attempted',
} as const;

export const InvestorNetworkRange = {
  COLD: '0-5',
  LIMITED: '5-15',
  DECENT: '15-30',
  STRONG: '30-50',
  EXTENSIVE: '50+',
} as const;

export const FounderCompanyStage = {
  IDEA: 'idea',
  BUILDING_PRODUCT: 'building_product',
  DESIGN_PARTNERS: 'design_partners',
  EARLY_CUSTOMERS: 'early_customers',
  REVENUE: 'revenue',
  SCALING: 'scaling',
} as const;

export const GeographyContext = {
  MAJOR_TECH_HUB: 'major_tech_hub',
  OUTSIDE_TECH_HUBS: 'outside_tech_hubs',
} as const;

export const founderLeads = sqliteTable('founder_leads', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  // Contact
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email'),

  // Company
  companyName: text('company_name'),
  companyDescription: text('company_description'),
  sector: text('sector'),

  // Extracted Tags
  primaryPersona: text('primary_persona'),
  secondaryPersona: text('secondary_persona'),
  fundraisingExperience: text('fundraising_experience'),
  investorNetworkNumber: integer('investor_network_number'),
  investorNetworkRange: text('investor_network_range'),
  companyStage: text('company_stage'),
  geographyContext: text('geography_context'),

  // Generated Outputs
  investorBlurb: text('investor_blurb'),
  oneLiner: text('one_liner'),

  // Conversation
  conversationHistory: text('conversation_history'), // JSON array of messages

  // Tracking
  status: text('status').notNull().default('in_progress'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  completedAt: text('completed_at'),
  convertedFounderId: integer('converted_founder_id').references(() => founders.id),

  // Link to public signup (if applicant came through public signup flow)
  publicUserId: integer('public_user_id'),
  publicCompanyId: integer('public_company_id'),

  // Blurb builder fields
  source: text('source').default('onboarding_chat'), // 'onboarding_chat' or 'blurb_builder'
  signalCategories: text('signal_categories'), // JSON string of detected signals + answers
});

export const founderLeadsRelations = relations(founderLeads, ({ one }) => ({
  convertedFounder: one(founders, {
    fields: [founderLeads.convertedFounderId],
    references: [founders.id],
  }),
}));

export type FounderLead = typeof founderLeads.$inferSelect;
export type NewFounderLead = typeof founderLeads.$inferInsert;

// Public Network Tables (for public-facing founder signup)

export const publicUsers = sqliteTable('public_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role'), // founder, node, investor, other
  roleOther: text('role_other'), // free text if role is 'other'
  nodeContacts: text('node_contacts'), // JSON array of {name, firm} for nodes
  status: text('status').notNull().default('pending'), // pending, approved, converted
  oneLiner: text('one_liner'),
  city: text('city'),
  linkedinUrl: text('linkedin_url'),
  twitterHandle: text('twitter_handle'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const publicCompanies = sqliteTable('public_companies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => publicUsers.id),
  companyName: text('company_name').notNull(),
  oneLiner: text('one_liner'),
  url: text('url'),
  sector: text('sector'),
  applicationStatus: text('application_status'), // null, 'applied', 'approved', 'declined'
  appliedAt: text('applied_at'),
  // Shadow AI application scorer — advisory only, never auto-decides.
  aiScore: integer('ai_score'),                  // 1-10
  aiRecommendation: text('ai_recommendation'),   // 'let_in' | 'meeting' | 'pass'
  aiReasoning: text('ai_reasoning'),
  aiScoredAt: text('ai_scored_at'),
  // The admin's own one-line reason for their decision — the gold training signal.
  decisionReason: text('decision_reason'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const publicSessions = sqliteTable('public_sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => publicUsers.id),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// Public Network Relations

export const publicUsersRelations = relations(publicUsers, ({ many }) => ({
  companies: many(publicCompanies),
  sessions: many(publicSessions),
}));

export const publicCompaniesRelations = relations(publicCompanies, ({ one }) => ({
  user: one(publicUsers, {
    fields: [publicCompanies.userId],
    references: [publicUsers.id],
  }),
}));

export const publicSessionsRelations = relations(publicSessions, ({ one }) => ({
  user: one(publicUsers, {
    fields: [publicSessions.userId],
    references: [publicUsers.id],
  }),
}));

export type PublicUser = typeof publicUsers.$inferSelect;
export type NewPublicUser = typeof publicUsers.$inferInsert;
export type PublicCompany = typeof publicCompanies.$inferSelect;
export type NewPublicCompany = typeof publicCompanies.$inferInsert;
export type PublicSession = typeof publicSessions.$inferSelect;
export type NewPublicSession = typeof publicSessions.$inferInsert;

// Voice Interview Tables

export const VoiceInterviewStatus = {
  RESEARCHING: 'researching',
  SENT: 'sent',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
  FAILED: 'failed',
} as const;

export const voiceInterviews = sqliteTable('voice_interviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicCompanyId: integer('public_company_id').notNull().references(() => publicCompanies.id),
  token: text('token').notNull().unique(),
  status: text('status').notNull().default('researching'),
  research: text('research'), // AI research summary
  questions: text('questions'), // JSON array of { question, reason }
  sentAt: text('sent_at'),
  completedAt: text('completed_at'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const voiceInterviewAnswers = sqliteTable('voice_interview_answers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  interviewId: integer('interview_id').notNull().references(() => voiceInterviews.id),
  questionIndex: integer('question_index').notNull(),
  audioUrl: text('audio_url').notNull(),
  durationSeconds: integer('duration_seconds'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const voiceInterviewsRelations = relations(voiceInterviews, ({ one, many }) => ({
  publicCompany: one(publicCompanies, {
    fields: [voiceInterviews.publicCompanyId],
    references: [publicCompanies.id],
  }),
  answers: many(voiceInterviewAnswers),
}));

export const voiceInterviewAnswersRelations = relations(voiceInterviewAnswers, ({ one }) => ({
  interview: one(voiceInterviews, {
    fields: [voiceInterviewAnswers.interviewId],
    references: [voiceInterviews.id],
  }),
}));

export type VoiceInterview = typeof voiceInterviews.$inferSelect;
export type NewVoiceInterview = typeof voiceInterviews.$inferInsert;
export type VoiceInterviewAnswer = typeof voiceInterviewAnswers.$inferSelect;
export type NewVoiceInterviewAnswer = typeof voiceInterviewAnswers.$inferInsert;

// Matching System Tables

export const MatchSuggestionStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
} as const;

// Investor category exclusions (sectors they do NOT want)
export const investorCategoryExclusions = sqliteTable('investor_category_exclusions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  investorId: integer('investor_id').notNull().references(() => investors.id),
  categoryId: integer('category_id').notNull().references(() => investorCategories.id),
});

// Persona hotness tiers (configurable ranking)
export const personaHotnessTiers = sqliteTable('persona_hotness_tiers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  persona: text('persona').notNull().unique(),
  tier: integer('tier').notNull(), // 1-7, higher = hotter
  label: text('label'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

// Match suggestions for admin review
export const matchSuggestions = sqliteTable('match_suggestions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull().references(() => founders.id),
  nodeId: integer('node_id').notNull().references(() => nodes.id),
  investorId: integer('investor_id').notNull().references(() => investors.id),
  founderHeatScore: integer('founder_heat_score').notNull(),
  investorReliabilityScore: integer('investor_reliability_score').notNull(),
  matchScore: integer('match_score').notNull(),
  matchReasoning: text('match_reasoning'), // JSON
  status: text('status').notNull().default('pending'),
  reviewedAt: text('reviewed_at'),
  rejectionReason: text('rejection_reason'),       // human-readable label / note
  rejectionCategory: text('rejection_category'),   // structured taxonomy code (drives learned suppression)
  introRequestId: integer('intro_request_id').references(() => introRequests.id),
  batchId: text('batch_id'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

// Matching Relations
export const investorCategoryExclusionsRelations = relations(investorCategoryExclusions, ({ one }) => ({
  investor: one(investors, {
    fields: [investorCategoryExclusions.investorId],
    references: [investors.id],
  }),
  category: one(investorCategories, {
    fields: [investorCategoryExclusions.categoryId],
    references: [investorCategories.id],
  }),
}));

export const matchSuggestionsRelations = relations(matchSuggestions, ({ one }) => ({
  founder: one(founders, {
    fields: [matchSuggestions.founderId],
    references: [founders.id],
  }),
  node: one(nodes, {
    fields: [matchSuggestions.nodeId],
    references: [nodes.id],
  }),
  investor: one(investors, {
    fields: [matchSuggestions.investorId],
    references: [investors.id],
  }),
  introRequest: one(introRequests, {
    fields: [matchSuggestions.introRequestId],
    references: [introRequests.id],
  }),
}));

export type InvestorCategoryExclusion = typeof investorCategoryExclusions.$inferSelect;
export type NewInvestorCategoryExclusion = typeof investorCategoryExclusions.$inferInsert;
export type PersonaHotnessTier = typeof personaHotnessTiers.$inferSelect;
export type NewPersonaHotnessTier = typeof personaHotnessTiers.$inferInsert;
export type MatchSuggestion = typeof matchSuggestions.$inferSelect;
export type NewMatchSuggestion = typeof matchSuggestions.$inferInsert;

// Instantly.ai Outreach
export const InstantlyCampaignStatus = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
} as const;

export const InstantlyLeadStatus = {
  PENDING: 'pending',
  CONTACTED: 'contacted',
  REPLIED: 'replied',
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
  NEUTRAL: 'neutral',
} as const;

export const instantlyCampaigns = sqliteTable('instantly_campaigns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  instantlyCampaignId: text('instantly_campaign_id').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('draft'),
  accountEmail: text('account_email'),
  leadsCount: integer('leads_count').notNull().default(0),
  repliedCount: integer('replied_count').notNull().default(0),
  positiveCount: integer('positive_count').notNull().default(0),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const instantlyLeads = sqliteTable('instantly_leads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  instantlyCampaignId: text('instantly_campaign_id').notNull(),
  investorName: text('investor_name').notNull(),
  investorFirm: text('investor_firm'),
  investorEmail: text('investor_email').notNull(),
  leadStatus: text('lead_status').notNull().default('pending'),
  replyText: text('reply_text'),
  investorId: integer('investor_id').references(() => investors.id),
  processed: integer('processed', { mode: 'boolean' }).notNull().default(false),
  processedAt: text('processed_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const instantlyCampaignsRelations = relations(instantlyCampaigns, ({ many }) => ({
  leads: many(instantlyLeads),
}));

export const instantlyLeadsRelations = relations(instantlyLeads, ({ one }) => ({
  campaign: one(instantlyCampaigns, {
    fields: [instantlyLeads.instantlyCampaignId],
    references: [instantlyCampaigns.instantlyCampaignId],
  }),
  investor: one(investors, {
    fields: [instantlyLeads.investorId],
    references: [investors.id],
  }),
}));

export type InstantlyCampaign = typeof instantlyCampaigns.$inferSelect;
export type NewInstantlyCampaign = typeof instantlyCampaigns.$inferInsert;
export type InstantlyLead = typeof instantlyLeads.$inferSelect;
export type NewInstantlyLead = typeof instantlyLeads.$inferInsert;

// Brands (sponsor CRM)

export const BrandStatus = {
  LEAD: 'lead',
  CONTACTED: 'contacted',
  IN_CONVERSATION: 'in_conversation',
  COMMITTED: 'committed',
  PASSED: 'passed',
} as const;

export const brands = sqliteTable('brands', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  contactName: text('contact_name'),
  contactEmail: text('contact_email'),
  status: text('status').notNull().default('lead'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;

// People captures — universal entry point for lead magnets (equity calculator,
// dilution planner, future tools). Public POST /api/people-captures writes
// here. De-duped on (email, source) so the same person hitting the same
// magnet twice doesn't bloat the table. The unified admin People view (PR 2)
// will UNION this in with founders / signups / public_users / founder_leads.
export const peopleCaptures = sqliteTable('people_captures', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull(),
  name: text('name'),
  city: text('city'),
  source: text('source').notNull(),
  metadata: text('metadata'),
  capturedAt: text('captured_at').notNull().default('CURRENT_TIMESTAMP'),
  autoEmailedAt: text('auto_emailed_at'),
});

export type PeopleCapture = typeof peopleCaptures.$inferSelect;
export type NewPeopleCapture = typeof peopleCaptures.$inferInsert;

// People tags — free-form tags attached to a person by email. Used to segment
// the unified People view ("AI-Austin", "vibe-coding-dinner-prospect",
// "fundraising-workshop"). Unique on (email, tag) so re-tagging is idempotent.
export const peopleTags = sqliteTable('people_tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull(),
  tag: text('tag').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type PeopleTag = typeof peopleTags.$inferSelect;
export type NewPeopleTag = typeof peopleTags.$inferInsert;

// Agent actions — the accountability ledger for the AI worker. Every action an
// agent tick takes (or proposes) is appended here: what it did, why, what it
// touched, and how it resolved. This is the single system-of-record that powers
// both the audit trail (review what the agent has been doing) and the scorecard
// (approval rate, volume, failure rate). It does NOT replace match_suggestions
// or Gmail drafts — those stay the domain surfaces; this is the meta-log over
// all of them, plus the approval gate for net-new autonomous actions.
export const agentActions = sqliteTable('agent_actions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Which agent/tick produced this, e.g. 'match-generator', 'auto-draft',
  // 'followup', 'intro-email', 'research'.
  agent: text('agent').notNull(),
  // What it did/proposes to do, e.g. 'generate_matches', 'draft_intro',
  // 'send_founder_email', 'enrich_investor'.
  actionType: text('action_type').notNull(),
  summary: text('summary').notNull(),          // human-readable one-liner
  reasoning: text('reasoning'),                // why the agent chose this
  entityType: text('entity_type'),             // 'investor' | 'founder' | 'intro_request' | ...
  entityId: integer('entity_id'),
  payload: text('payload'),                    // JSON: the proposed change / inputs
  // proposed = needs approval, approved/rejected = decided, executed = done,
  // failed = execution error, logged = recorded after-the-fact (no gate needed).
  status: text('status').notNull().default('logged'),
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
  result: text('result'),                      // JSON: execution result / error
  decidedBy: text('decided_by'),               // admin who approved/rejected
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  decidedAt: text('decided_at'),
  executedAt: text('executed_at'),
});

export type AgentAction = typeof agentActions.$inferSelect;
export type NewAgentAction = typeof agentActions.$inferInsert;
// People overrides — admin-edited values that supersede whatever the merged
// source data shows for that email. Keyed by email so one row per person.
// Non-destructive: source tables (founders, public_users, founder_leads,
// people_captures) are untouched; the Directory view layers these on top.
export const peopleOverrides = sqliteTable('people_overrides', {
  email: text('email').primaryKey(),
  name: text('name'),
  city: text('city'),
  company: text('company'),
  notes: text('notes'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type PeopleOverride = typeof peopleOverrides.$inferSelect;
export type NewPeopleOverride = typeof peopleOverrides.$inferInsert;

// Cron run log — one row per scheduled job invocation. Lets us answer
// "did the weekly digest actually fire last week?" with a single query
// instead of guessing from machine state. Status starts as 'running' on
// insert; the wrapper updates to 'success' / 'error' on completion.
export const cronRuns = sqliteTable('cron_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  startedAt: text('started_at').notNull().default('CURRENT_TIMESTAMP'),
  finishedAt: text('finished_at'),
  status: text('status').notNull().default('running'),
  result: text('result'),
  error: text('error'),
});

export type CronRun = typeof cronRuns.$inferSelect;
export type NewCronRun = typeof cronRuns.$inferInsert;

// Agent settings — single-row table holding the kill switches + thresholds
// for autonomous behaviors. Use id=1 as a sentinel so we can upsert.
//
// Today (Phase 2): auto-send the founder↔investor handoff on a high-confidence
// 'yes' classification. Future phases will add more flags here (auto-send the
// original intro, auto-send bumps, etc.).
export const agentSettings = sqliteTable('agent_settings', {
  id: integer('id').primaryKey(),
  autoSendHandoff: integer('auto_send_handoff', { mode: 'boolean' }).notNull().default(false),
  autoSendHandoffMinConfidence: text('auto_send_handoff_min_confidence').notNull().default('0.9'),
  autoSendHandoffMaxReplyChars: integer('auto_send_handoff_max_reply_chars').notNull().default(400),
  // Kill switch: auto-reply "all good, thanks!" to a high-confidence pass and
  // label+archive the thread. Gated on the same min-confidence floor as handoff.
  autoReplyToPass: integer('auto_reply_to_pass', { mode: 'boolean' }).notNull().default(false),
  // Pass-ack gets its OWN length cap (decoupled from the handoff cap). Real pass
  // emails are often a few sentences, so the 400-char handoff cap was too tight
  // and silently skipped most passes. Default generous; raise/lower to taste.
  autoReplyToPassMaxReplyChars: integer('auto_reply_to_pass_max_reply_chars').notNull().default(1500),
  // Kill switch: auto-SEND the templated follow-up bumps instead of leaving them
  // as Gmail drafts. Same cap/cooldown/no-reply rails apply either way.
  autoSendFollowups: integer('auto_send_followups', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type AgentSettings = typeof agentSettings.$inferSelect;
export type NewAgentSettings = typeof agentSettings.$inferInsert;

// MCP access tokens — a founder mints one of these to connect their AI client
// (Claude Desktop, Cursor, …) to their pipeline via the MCP server. Each token
// is scoped to exactly one founder; the MCP server resolves token → founderId
// and every data operation runs scoped to that founder. The raw token is shown
// to the founder ONCE at creation; only its SHA-256 hash is stored here, so a DB
// leak can't reconstruct a usable token. Supports a human label, optional expiry,
// and revocation.
export const mcpTokens = sqliteTable('mcp_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').notNull().references(() => founders.id),
  // SHA-256 hex of the raw token. Unique so verification is a single indexed lookup.
  tokenHash: text('token_hash').notNull().unique(),
  // First few chars of the raw token (e.g. 'mcp_a1b2') — display only, to help
  // the founder tell their tokens apart. Never enough to authenticate.
  tokenPrefix: text('token_prefix').notNull(),
  name: text('name'),                          // human label, e.g. "Claude Desktop"
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  expiresAt: text('expires_at'),               // null = no expiry
  revokedAt: text('revoked_at'),               // null = active
  lastUsedAt: text('last_used_at'),
});

export type McpToken = typeof mcpTokens.$inferSelect;
export type NewMcpToken = typeof mcpTokens.$inferInsert;

// Mock VC call analyses. A founder does a practice pitch call (recorded, then
// transcribed); we run the transcript through Claude playing an experienced
// investor + coach and store a structured readout: an overall score, a
// per-dimension scorecard, the founder's blind spots (where they hedged, dodged,
// or didn't know their numbers), and the top coaching fixes before the real
// raise. Advisory prep only — MatCap sharpens the pitch, the founder owns it.
// Linked to whichever founder record we have: `founders` (portfolio) and/or
// `publicCompanies` (applicant). The scorecard/blindSpots/coaching columns hold
// JSON strings (parsed on read), same as other JSON-in-text columns here.
export const mockCallAnalyses = sqliteTable('mock_call_analyses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  founderId: integer('founder_id').references(() => founders.id),
  publicCompanyId: integer('public_company_id').references(() => publicCompanies.id),
  // Denormalized labels so an analysis is readable even if the source row moves.
  founderName: text('founder_name'),
  companyName: text('company_name'),
  transcript: text('transcript').notNull(),
  overallScore: integer('overall_score'),      // 1–10 headline
  summary: text('summary'),                     // 2–3 sentence readout in Mat's voice
  scorecard: text('scorecard'),                 // JSON: [{ dimension, score (1-5), note }]
  blindSpots: text('blind_spots'),              // JSON: [{ moment, issue, whyItMatters }]
  coaching: text('coaching'),                   // JSON: [{ fix, how }]
  persona: text('persona'),                     // Gym persona key the founder practiced against (null = ad-hoc)
  tavusConversationId: text('tavus_conversation_id'), // source Tavus conversation, for idempotency
  model: text('model'),                         // model string used, for auditing
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type MockCallAnalysis = typeof mockCallAnalyses.$inferSelect;
export type NewMockCallAnalysis = typeof mockCallAnalyses.$inferInsert;
