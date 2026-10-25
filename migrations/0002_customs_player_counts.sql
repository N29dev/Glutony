-- Optional host-reported player counts for BL:R Customs.
-- These are NOT live Roblox server metrics. Only listing owners can update.
ALTER TABLE customs ADD COLUMN player_current INTEGER CHECK (player_current IS NULL OR player_current BETWEEN 0 AND 100);
ALTER TABLE customs ADD COLUMN player_capacity INTEGER CHECK (player_capacity IS NULL OR player_capacity BETWEEN 1 AND 100);
ALTER TABLE customs ADD COLUMN player_reported_at INTEGER;
