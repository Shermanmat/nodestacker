-- Default all investors without sector assignments to "Generalist"
-- This assigns the Generalist sector category to every investor who doesn't
-- already have any sector categories assigned.

INSERT INTO `investor_category_assignments` (`investor_id`, `category_id`)
SELECT i.id, gc.id
FROM `investors` i
CROSS JOIN `investor_categories` gc
WHERE gc.name = 'Generalist' AND gc.type = 'sector'
  AND i.id NOT IN (
    SELECT DISTINCT ica.investor_id
    FROM `investor_category_assignments` ica
    JOIN `investor_categories` ic ON ica.category_id = ic.id
    WHERE ic.type = 'sector'
  );
