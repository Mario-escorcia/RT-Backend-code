-- Authentication: users + server-side sessions, and per-user ownership of all data.

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_users_email ON users (lower(email));

-- The cookie holds a random token; only its SHA-256 hash is stored, so a DB leak cannot hijack sessions.
CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_sessions_user    ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Ownership. Rows created before authentication existed keep user_id NULL until the
-- first account is registered, which then claims them (see users.repository.ts).
ALTER TABLE search_events ADD COLUMN user_id UUID REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE searches      ADD COLUMN user_id UUID REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE activity_log  ADD COLUMN user_id UUID REFERENCES users (id) ON DELETE CASCADE;

CREATE INDEX idx_search_events_user ON search_events (user_id, created_at DESC);
CREATE INDEX idx_searches_user      ON searches (user_id, created_at DESC);
CREATE INDEX idx_searches_user_topic ON searches (user_id, normalized_topic);
CREATE INDEX idx_activity_log_user  ON activity_log (user_id, created_at DESC);

-- Headline metrics, now per user.
DROP VIEW user_stats;
CREATE VIEW user_stats AS
SELECT
  u.id AS user_id,
  (SELECT count(*) FROM search_events e WHERE e.user_id = u.id AND e.status = 'completed')::int                         AS total_searches,
  (SELECT count(DISTINCT e.normalized_topic) FROM search_events e WHERE e.user_id = u.id AND e.status = 'completed')::int AS unique_topics,
  (SELECT count(*) FROM searches s WHERE s.user_id = u.id)::int                                                          AS saved_count,
  (SELECT count(*) FROM searches s WHERE s.user_id = u.id AND s.is_favorite)::int                                        AS favorite_count,
  (SELECT coalesce(sum(a.duration_ms), 0) FROM activity_log a WHERE a.user_id = u.id)::float8                            AS total_time_ms,
  (SELECT coalesce(sum(a.duration_ms), 0) FROM activity_log a WHERE a.user_id = u.id AND a.kind = 'research')::float8    AS research_time_ms,
  (SELECT coalesce(sum(a.duration_ms), 0) FROM activity_log a WHERE a.user_id = u.id AND a.kind = 'reading')::float8     AS reading_time_ms,
  (SELECT coalesce(sum(e.source_count), 0) FROM search_events e WHERE e.user_id = u.id AND e.status = 'completed')::int  AS total_sources,
  (SELECT coalesce(avg(e.research_ms), 0) FROM search_events e WHERE e.user_id = u.id AND e.status = 'completed')::float8 AS avg_research_ms
FROM users u;
