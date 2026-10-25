-- Glutony Customs: community-shared Roblox private server invitations.
-- Listings are public to visitors; never store Discord OAuth access tokens.
CREATE TABLE IF NOT EXISTS customs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  title TEXT NOT NULL,
  region TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  invite_url TEXT NOT NULL,
  invite_code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed','hidden')),
  CHECK(length(owner_id) BETWEEN 15 AND 22),
  CHECK(length(title) BETWEEN 4 AND 64)
);
CREATE INDEX IF NOT EXISTS customs_active_expires ON customs(status, expires_at, created_at);
CREATE INDEX IF NOT EXISTS customs_owner_created ON customs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customs_invite_status ON customs(invite_code, status, expires_at);

CREATE TABLE IF NOT EXISTS customs_reports (
  listing_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(listing_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS customs_reports_user_time ON customs_reports(reporter_id, created_at DESC);
CREATE TABLE IF NOT EXISTS customs_bans (
  owner_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
