-- Public BL:R RoValra discovery cache; strictly sanitized IDs and locations only.
-- All modes share one request gate to avoid bursts and honor provider cooldown.
CREATE TABLE IF NOT EXISTS rovalra_discovery_gate (
  key TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rovalra_discovery_regions (
  mode TEXT NOT NULL,
  country_code TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (mode, country_code)
);
CREATE INDEX IF NOT EXISTS idx_rovalra_discovery_observed
 ON rovalra_discovery_regions(mode, observed_at);
