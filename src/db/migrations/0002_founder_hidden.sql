-- Add hidden field to founders table
ALTER TABLE founders ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
