-- Persistent, privacy-conscious Discord slash-command analytics.
-- No raw user IDs, guild IDs, names, messages, or URLs are stored.
CREATE TABLE IF NOT EXISTS stats_seen (
  interaction_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stats_seen_time ON stats_seen(created_at);

CREATE TABLE IF NOT EXISTS stats_daily (
  day TEXT NOT NULL,
  command TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, command, mode)
);

CREATE TABLE IF NOT EXISTS stats_unique (
  day TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK(dimension IN ('user', 'guild')),
  token TEXT NOT NULL,
  PRIMARY KEY (day, dimension, token)
);
CREATE INDEX IF NOT EXISTS idx_stats_unique_dimension_day
  ON stats_unique(dimension, day);
