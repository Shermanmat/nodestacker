-- Public users (for public-facing network signup)
CREATE TABLE IF NOT EXISTS public_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  one_liner TEXT,
  city TEXT,
  linkedin_url TEXT,
  twitter_handle TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Companies owned by public users
CREATE TABLE IF NOT EXISTS public_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES public_users(id),
  company_name TEXT NOT NULL,
  one_liner TEXT,
  url TEXT,
  sector TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Auth sessions for public users
CREATE TABLE IF NOT EXISTS public_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public_users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_public_users_email ON public_users(email);
CREATE INDEX IF NOT EXISTS idx_public_companies_user_id ON public_companies(user_id);
CREATE INDEX IF NOT EXISTS idx_public_sessions_user_id ON public_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_public_sessions_expires_at ON public_sessions(expires_at);

-- Link founder_leads to public signup (for tracking where applicants came from)
ALTER TABLE founder_leads ADD COLUMN public_user_id INTEGER REFERENCES public_users(id);
ALTER TABLE founder_leads ADD COLUMN public_company_id INTEGER REFERENCES public_companies(id);
