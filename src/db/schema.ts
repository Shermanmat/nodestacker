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
