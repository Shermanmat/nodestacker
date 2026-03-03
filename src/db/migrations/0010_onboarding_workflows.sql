-- Onboarding workflows table for tracking founder onboarding lifecycle
CREATE TABLE IF NOT EXISTS `onboarding_workflows` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `portfolio_company_id` integer NOT NULL UNIQUE REFERENCES `portfolio_companies`(`id`) ON DELETE CASCADE,
  `status` text NOT NULL DEFAULT 'offer_pending',

  -- Offer details
  `offer_equity_percent` text,
  `offer_notes` text,
  `offer_sent_at` text,
  `offer_accepted_at` text,

  -- Entity info (from founder)
  `entity_name` text,
  `entity_type` text,
  `entity_state` text,
  `authorized_shares` integer,
  `share_price` text DEFAULT '0.001',
  `entity_info_received_at` text,

  -- E-signature tracking (advisory agreement)
  `esign_document_id` text,
  `esign_signature_request_id` text,
  `agreement_sent_at` text,
  `founder_signed_at` text,
  `admin_signed_at` text,
  `signed_document_url` text,

  -- Equity purchase agreement (founder sends to MatCap)
  `equity_agreement_received_at` text,
  `equity_agreement_url` text,
  `equity_agreement_signed_at` text,

  -- Share purchase
  `share_purchase_amount` text,
  `share_purchase_date` text,
  `share_purchase_method` text,

  -- 83(b) election
  `election_83b_filed_at` text,
  `election_83b_proof_url` text,

  -- Stock certificate (founder issues to MatCap)
  `certificate_received_at` text,
  `certificate_url` text,
  `certificate_number` text,
  `equity_verified_at` text,

  -- Google Drive
  `drive_folder_id` text,
  `drive_folder_url` text,

  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_onboarding_workflows_status` ON `onboarding_workflows` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_onboarding_workflows_portfolio_company` ON `onboarding_workflows` (`portfolio_company_id`);
--> statement-breakpoint

-- Onboarding events table for audit logging
CREATE TABLE IF NOT EXISTS `onboarding_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `workflow_id` integer NOT NULL REFERENCES `onboarding_workflows`(`id`) ON DELETE CASCADE,
  `event_type` text NOT NULL,
  `actor` text NOT NULL,
  `actor_email` text,
  `details` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_onboarding_events_workflow` ON `onboarding_events` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_onboarding_events_type` ON `onboarding_events` (`event_type`);
