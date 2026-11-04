-- Shared last-successful Roblox public server snapshots.
-- Contains public server metadata only, no Roblox credentials or user profiles.
CREATE TABLE IF NOT EXISTS server_snapshots (
  cache_key TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
