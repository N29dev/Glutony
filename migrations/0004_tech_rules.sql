-- Unofficial BL:R tech / bug directory edits. Baseline remains in the static website.
-- Only admin changes and tombstones are stored here.
CREATE TABLE IF NOT EXISTS tech_overrides (
  id TEXT PRIMARY KEY,
  data TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS tech_overrides_updated_at_idx ON tech_overrides(updated_at);
