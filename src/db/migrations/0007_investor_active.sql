-- Add active field to investors (default true)
ALTER TABLE investors ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
