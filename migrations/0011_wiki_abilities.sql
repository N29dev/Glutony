-- Tested wiki ability values. Append-only revisions preserve all published values.
CREATE TABLE IF NOT EXISTS wiki_ability_revisions (
 style TEXT NOT NULL,
 ability_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 data TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(style,ability_id,revision)
);
