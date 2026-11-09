-- One global request gate for the Roblox public-server API.
-- Prevents overlapping 8v8/Pro scans across Cloudflare Worker isolates
-- and preserves provider backoff even when the Worker is restarted.
CREATE TABLE IF NOT EXISTS server_scan_gate (
  gate_key TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at INTEGER,
  last_success_at INTEGER
);
