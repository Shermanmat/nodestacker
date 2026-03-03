-- Add email_date field to inbound_intro_logs (original email date from Postmark)
ALTER TABLE inbound_intro_logs ADD COLUMN email_date TEXT;
