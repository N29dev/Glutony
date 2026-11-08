-- Quota for opt-in, public cache-miss lookups of BL:R server regions.
-- Caller identifiers are HMAC pseudonyms keyed by the existing Worker SETUP_KEY.
-- Never store raw IP addresses, credentials or Roblox session information.
CREATE TABLE IF NOT EXISTS shared_region_lookup_quota (
  caller_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  lookup_count INTEGER NOT NULL CHECK(lookup_count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_shared_region_lookup_quota_time
  ON shared_region_lookup_quota(window_start);
