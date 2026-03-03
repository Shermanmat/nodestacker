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
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const investors = sqliteTable('investors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  firm: text('firm'),
  role: text('role'),
  focusAreas: text('focus_areas'), // JSON array stored as text
  checkSize: text('check_size'),
  geography: text('geography'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  tags: text('tags'), // JSON array of auto-generated tags from AI research
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
  passReason: text('pass_reason'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

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
  currentValuation: integer('current_valuation'), // in dollars
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

// Network Founders Tables (for podcast network matching)

export const NetworkMatchStatus = {
  SUGGESTED: 'suggested',
  INTERESTED: 'interested',
  INTRO_MADE: 'intro_made',
  PASSED: 'passed',
} as const;

export const NetworkIntroRequestStatus = {
  PENDING: 'pending',
  MATCHED: 'matched',
  COMPLETED: 'completed',
} as const;

export const networkFounders = sqliteTable('network_founders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  companyName: text('company_name').notNull(),
  email: text('email'),
  linkedinUrl: text('linkedin_url'),
  episodeTitle: text('episode_title').notNull(),
  episodeUrl: text('episode_url'),
  episodeDate: text('episode_date'),
  notes: text('notes'), // Admin notes (e.g., "Company dead", "Now at Block")
  status: text('status').default('active'), // active, inactive, unknown
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const networkFounderResearch = sqliteTable('network_founder_research', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  networkFounderId: integer('network_founder_id').notNull().references(() => networkFounders.id),
  companyDescription: text('company_description'),
  industry: text('industry'),
  companyStage: text('company_stage'),
  employeeCount: text('employee_count'),
  targetCustomers: text('target_customers'),
  recentNews: text('recent_news'),
  sourceUrls: text('source_urls'), // JSON array
  status: text('status').notNull().default('pending'), // pending, in_progress, completed, failed
  errorMessage: text('error_message'),
  researchedAt: text('researched_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const networkIntroRequests = sqliteTable('network_intro_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  portfolioCompanyId: integer('portfolio_company_id').notNull().references(() => portfolioCompanies.id),
  requestText: text('request_text').notNull(),
  status: text('status').notNull().default('pending'), // pending, matched, completed
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const networkMatches = sqliteTable('network_matches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  introRequestId: integer('intro_request_id').notNull().references(() => networkIntroRequests.id),
  networkFounderId: integer('network_founder_id').notNull().references(() => networkFounders.id),
  matchScore: integer('match_score').notNull(),
  matchReasoning: text('match_reasoning'),
  status: text('status').notNull().default('suggested'), // suggested, interested, intro_made, passed
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

// Network Relations

export const networkFoundersRelations = relations(networkFounders, ({ many }) => ({
  research: many(networkFounderResearch),
  matches: many(networkMatches),
}));

export const networkFounderResearchRelations = relations(networkFounderResearch, ({ one }) => ({
  networkFounder: one(networkFounders, {
    fields: [networkFounderResearch.networkFounderId],
    references: [networkFounders.id],
  }),
}));

export const networkIntroRequestsRelations = relations(networkIntroRequests, ({ one, many }) => ({
  portfolioCompany: one(portfolioCompanies, {
    fields: [networkIntroRequests.portfolioCompanyId],
    references: [portfolioCompanies.id],
  }),
  matches: many(networkMatches),
}));

export const networkMatchesRelations = relations(networkMatches, ({ one }) => ({
  introRequest: one(networkIntroRequests, {
    fields: [networkMatches.introRequestId],
    references: [networkIntroRequests.id],
  }),
  networkFounder: one(networkFounders, {
    fields: [networkMatches.networkFounderId],
    references: [networkFounders.id],
  }),
}));

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
export type NetworkFounder = typeof networkFounders.$inferSelect;
export type NewNetworkFounder = typeof networkFounders.$inferInsert;
export type NetworkFounderResearch = typeof networkFounderResearch.$inferSelect;
export type NewNetworkFounderResearch = typeof networkFounderResearch.$inferInsert;
export type NetworkIntroRequest = typeof networkIntroRequests.$inferSelect;
export type NewNetworkIntroRequest = typeof networkIntroRequests.$inferInsert;
export type NetworkMatch = typeof networkMatches.$inferSelect;
export type NewNetworkMatch = typeof networkMatches.$inferInsert;

// Admin Sessions Table (persistent admin login sessions)
export const adminSessions = sqliteTable('admin_sessions', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type AdminSession = typeof adminSessions.$inferSelect;
export type NewAdminSession = typeof adminSessions.$inferInsert;

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
  ENTITY_INFO_PENDING: 'entity_info_pending',
  ENTITY_INFO_RECEIVED: 'entity_info_received',
  ADVISORY_AGREEMENT_SENT: 'advisory_agreement_sent',
  ADMIN_SIGNED: 'admin_signed',
  FOUNDER_SIGNED: 'founder_signed',
  EQUITY_AGREEMENT_PENDING: 'equity_agreement_pending',
  EQUITY_AGREEMENT_SIGNED: 'equity_agreement_signed',
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
  EQUITY_AGREEMENT_UPLOADED: 'equity_agreement_uploaded',
  EQUITY_AGREEMENT_SIGNED: 'equity_agreement_signed',
  SHARES_PURCHASED: 'shares_purchased',
  ELECTION_83B_FILED: '83b_filed',
  CERTIFICATE_UPLOADED: 'certificate_uploaded',
  CERTIFICATE_VERIFIED: 'certificate_verified',
  WORKFLOW_COMPLETED: 'workflow_completed',
  REMINDER_SENT: 'reminder_sent',
  WEBHOOK_RECEIVED: 'webhook_received',
  DOCUMENT_UPLOADED: 'document_uploaded',
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

  // Offer details
  offerEquityPercent: text('offer_equity_percent'),
  offerNotes: text('offer_notes'),
  offerSentAt: text('offer_sent_at'),
  offerAcceptedAt: text('offer_accepted_at'),

  // Vesting schedule
  vestingMonths: integer('vesting_months').default(48),
  vestingCliffMonths: integer('vesting_cliff_months').default(0),
  vestingStartDate: text('vesting_start_date'),

  // Entity info (from founder)
  entityName: text('entity_name'),
  entityType: text('entity_type'),
  entityState: text('entity_state'),
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

  // Equity purchase agreement (founder sends to MatCap)
  equityAgreementReceivedAt: text('equity_agreement_received_at'),
  equityAgreementUrl: text('equity_agreement_url'),
  equityAgreementSignedAt: text('equity_agreement_signed_at'),

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

// Onboarding Relations
export const onboardingWorkflowsRelations = relations(onboardingWorkflows, ({ one, many }) => ({
  portfolioCompany: one(portfolioCompanies, {
    fields: [onboardingWorkflows.portfolioCompanyId],
    references: [portfolioCompanies.id],
  }),
  events: many(onboardingEvents),
}));

export const onboardingEventsRelations = relations(onboardingEvents, ({ one }) => ({
  workflow: one(onboardingWorkflows, {
    fields: [onboardingEvents.workflowId],
    references: [onboardingWorkflows.id],
  }),
}));

export type OnboardingWorkflow = typeof onboardingWorkflows.$inferSelect;
export type NewOnboardingWorkflow = typeof onboardingWorkflows.$inferInsert;
export type OnboardingEvent = typeof onboardingEvents.$inferSelect;
export type NewOnboardingEvent = typeof onboardingEvents.$inferInsert;
