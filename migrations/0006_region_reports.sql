-- Player-contributed region observations for currently sampled public servers.
-- Pseudonymous reporter hashes only; reports expire after six hours.
CREATE TABLE IF NOT EXISTS server_region_reports (
  place_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  reporter_hash TEXT NOT NULL,
  region_code TEXT NOT NULL CHECK(region_code IN ('EU','NA','SA','AS','OC','ME','AF')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (place_id, server_id, reporter_hash)
);
CREATE INDEX IF NOT EXISTS idx_server_region_reports_recent
  ON server_region_reports(place_id, server_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_server_region_reports_reporter
  ON server_region_reports(reporter_hash, updated_at);
