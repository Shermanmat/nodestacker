-- Founder Leads table for conversational onboarding
CREATE TABLE IF NOT EXISTS founder_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Contact
  first_name TEXT,
  last_name TEXT,
  email TEXT,

  -- Company
  company_name TEXT,
  company_description TEXT,
  sector TEXT,

  -- Extracted Tags
  primary_persona TEXT,
  secondary_persona TEXT,
  fundraising_experience TEXT,
  investor_network_number INTEGER,
  investor_network_range TEXT,
  company_stage TEXT,
  geography_context TEXT,

  -- Generated Outputs
  investor_blurb TEXT,
  one_liner TEXT,

  -- Conversation
  conversation_history TEXT,

  -- Tracking
  status TEXT NOT NULL DEFAULT 'in_progress',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  converted_founder_id INTEGER REFERENCES founders(id)
);

-- Index for quick lookups by status
CREATE INDEX IF NOT EXISTS idx_founder_leads_status ON founder_leads(status);

-- Index for email lookups
CREATE INDEX IF NOT EXISTS idx_founder_leads_email ON founder_leads(email);
