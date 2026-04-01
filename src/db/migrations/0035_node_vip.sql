ALTER TABLE nodes ADD COLUMN vip integer NOT NULL DEFAULT 1;
-- Mat Sherman's network is not VIP (always available for intros)
UPDATE nodes SET vip = 0 WHERE id = 2;
