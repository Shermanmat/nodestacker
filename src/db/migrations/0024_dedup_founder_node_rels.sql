-- Remove duplicate founder_node_relationships, keeping the lowest-id row per (founder_id, node_id) pair
DELETE FROM `founder_node_relationships`
WHERE id NOT IN (
  SELECT MIN(id)
  FROM `founder_node_relationships`
  GROUP BY founder_id, node_id
);
--> statement-breakpoint

-- Add a unique constraint to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS `idx_founder_node_unique` ON `founder_node_relationships` (`founder_id`, `node_id`);
