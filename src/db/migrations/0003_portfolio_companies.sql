-- Portfolio companies table
CREATE TABLE portfolio_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  founder_id INTEGER NOT NULL UNIQUE REFERENCES founders(id),
  investment_date TEXT,
  equity_percent TEXT,
  current_valuation INTEGER,
  advisory_signed INTEGER NOT NULL DEFAULT 0,
  equity_signed INTEGER NOT NULL DEFAULT 0,
  shares_paid INTEGER NOT NULL DEFAULT 0,
  certificate_received INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
