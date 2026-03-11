-- Deduplicate Kelvin Beachum: keep the lowest-id investor,
-- reassign all related records to it, then delete the duplicates.

-- Reassign intro_requests from duplicate Kelvin Beachum entries to the first one
UPDATE `intro_requests`
SET investor_id = (
  SELECT MIN(id) FROM `investors` WHERE name = 'Kelvin Beachum'
)
WHERE investor_id IN (
  SELECT id FROM `investors` WHERE name = 'Kelvin Beachum'
  AND id != (SELECT MIN(id) FROM `investors` WHERE name = 'Kelvin Beachum')
);
--> statement-breakpoint

-- Reassign node_investor_connections from duplicates to the first one
-- (delete dupes to avoid unique constraint conflicts)
DELETE FROM `node_investor_connections`
WHERE investor_id IN (
  SELECT id FROM `investors` WHERE name = 'Kelvin Beachum'
  AND id != (SELECT MIN(id) FROM `investors` WHERE name = 'Kelvin Beachum')
);
--> statement-breakpoint

-- Delete category assignments from duplicates
DELETE FROM `investor_category_assignments`
WHERE investor_id IN (
  SELECT id FROM `investors` WHERE name = 'Kelvin Beachum'
  AND id != (SELECT MIN(id) FROM `investors` WHERE name = 'Kelvin Beachum')
);
--> statement-breakpoint

-- Delete duplicate Kelvin Beachum investors (keep the first one)
DELETE FROM `investors`
WHERE name = 'Kelvin Beachum'
AND id != (SELECT MIN(id) FROM `investors` WHERE name = 'Kelvin Beachum');
--> statement-breakpoint

-- Fix the firm name typo on the keeper
UPDATE `investors`
SET firm = 'Trenches Capital'
WHERE name = 'Kelvin Beachum';
