ALTER TABLE onboarding_workflows ADD COLUMN intro_requests_per_week INTEGER DEFAULT 3;
ALTER TABLE onboarding_workflows ADD COLUMN intro_requests_revisit_date TEXT;
