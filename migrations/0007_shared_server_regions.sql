-- Short-lived region observations shared between Discord, website and Thirst.
-- This table holds only public Roblox place/server IDs and sanitized
-- RoValra location metadata. Never store credentials, player tokens, IPs,
-- datacenter identifiers or complete upstream response bodies.
CREATE TABLE IF NOT EXISTS shared_server_regions (
  place_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (place_id, server_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_server_regions_expiry
  ON shared_server_regions(expires_at);
