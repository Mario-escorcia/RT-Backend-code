-- Knowledge Hub initial schema
-- search_events : every research run (saved or not). Feeds the usage analytics.
-- searches      : knowledge the user decided to keep ("Guardar").
-- activity_log  : time tracking (research time + reading time) for the dashboard.
-- user_stats    : aggregated view with the headline metrics.

CREATE TABLE search_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic            TEXT        NOT NULL,
  normalized_topic TEXT        NOT NULL,
  language         VARCHAR(5)  NOT NULL DEFAULT 'es',
  provider         VARCHAR(20) NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'completed'
                   CHECK (status IN ('completed', 'failed', 'cancelled')),
  category         VARCHAR(40),
  research_ms      INTEGER     NOT NULL DEFAULT 0 CHECK (research_ms >= 0),
  source_count     INTEGER     NOT NULL DEFAULT 0 CHECK (source_count >= 0),
  result           JSONB,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_search_events_created_at ON search_events (created_at DESC);
CREATE INDEX idx_search_events_topic      ON search_events (normalized_topic);
CREATE INDEX idx_search_events_status     ON search_events (status);

CREATE TABLE searches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID UNIQUE REFERENCES search_events (id) ON DELETE SET NULL,
  topic            TEXT        NOT NULL,
  normalized_topic TEXT        NOT NULL,
  language         VARCHAR(5)  NOT NULL DEFAULT 'es',
  category         VARCHAR(40),
  summary          TEXT        NOT NULL,
  raw_data         JSONB       NOT NULL,
  sources          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  tags             TEXT[]      NOT NULL DEFAULT '{}',
  provider         VARCHAR(20) NOT NULL,
  is_favorite      BOOLEAN     NOT NULL DEFAULT false,
  view_count       INTEGER     NOT NULL DEFAULT 0,
  last_viewed_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector    TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(topic, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(summary, '')), 'B')
  ) STORED
);

CREATE INDEX idx_searches_created_at ON searches (created_at DESC);
CREATE INDEX idx_searches_category   ON searches (category);
CREATE INDEX idx_searches_topic      ON searches (normalized_topic);
CREATE INDEX idx_searches_favorite   ON searches (is_favorite) WHERE is_favorite;
CREATE INDEX idx_searches_vector     ON searches USING GIN (search_vector);
CREATE INDEX idx_searches_tags       ON searches USING GIN (tags);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_searches_updated_at
  BEFORE UPDATE ON searches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE activity_log (
  id          BIGSERIAL PRIMARY KEY,
  kind        VARCHAR(20) NOT NULL CHECK (kind IN ('research', 'reading')),
  duration_ms INTEGER     NOT NULL CHECK (duration_ms >= 0),
  event_id    UUID REFERENCES search_events (id) ON DELETE SET NULL,
  search_id   UUID REFERENCES searches (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_log_created_at ON activity_log (created_at DESC);

CREATE VIEW user_stats AS
SELECT
  (SELECT count(*) FROM search_events WHERE status = 'completed')::int                         AS total_searches,
  (SELECT count(DISTINCT normalized_topic) FROM search_events WHERE status = 'completed')::int AS unique_topics,
  (SELECT count(*) FROM searches)::int                                                         AS saved_count,
  (SELECT count(*) FROM searches WHERE is_favorite)::int                                       AS favorite_count,
  (SELECT coalesce(sum(duration_ms), 0) FROM activity_log)::float8                             AS total_time_ms,
  (SELECT coalesce(sum(duration_ms), 0) FROM activity_log WHERE kind = 'research')::float8     AS research_time_ms,
  (SELECT coalesce(sum(duration_ms), 0) FROM activity_log WHERE kind = 'reading')::float8      AS reading_time_ms,
  (SELECT coalesce(sum(source_count), 0) FROM search_events WHERE status = 'completed')::int   AS total_sources,
  (SELECT coalesce(avg(research_ms), 0) FROM search_events WHERE status = 'completed')::float8 AS avg_research_ms;
