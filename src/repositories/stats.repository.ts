import { query } from '../db/pool.js';

export type PeriodUnit = 'day' | 'week' | 'month';

export interface PeriodPoint {
  period: string;
  searches: number;
  saved: number;
  timeMs: number;
}

/**
 * Activity per period (day/week/month) in the user's timezone, with empty periods filled with zeros.
 * `unit` is whitelisted by the type and validated by the route.
 */
export async function periodSeries(userId: string, timezone: string, unit: PeriodUnit, count: number): Promise<PeriodPoint[]> {
  const { rows } = await query<PeriodPoint>(
    `WITH bounds AS (
        SELECT date_trunc($2::text, now() AT TIME ZONE $1::text) AS current_period,
               ('1 ' || $2::text)::interval AS step
     ),
     periods AS (
        SELECT generate_series(current_period - ($3::int - 1) * step, current_period, step) AS p FROM bounds
     ),
     first_period AS (SELECT min(p) AS since FROM periods),
     ev AS (
        SELECT date_trunc($2::text, created_at AT TIME ZONE $1::text) AS p, count(*)::int AS searches
          FROM search_events, first_period
         WHERE user_id = $4 AND status = 'completed' AND created_at AT TIME ZONE $1::text >= since
         GROUP BY 1
     ),
     sv AS (
        SELECT date_trunc($2::text, created_at AT TIME ZONE $1::text) AS p, count(*)::int AS saved
          FROM searches, first_period
         WHERE user_id = $4 AND created_at AT TIME ZONE $1::text >= since
         GROUP BY 1
     ),
     act AS (
        SELECT date_trunc($2::text, created_at AT TIME ZONE $1::text) AS p, sum(duration_ms)::float8 AS time_ms
          FROM activity_log, first_period
         WHERE user_id = $4 AND created_at AT TIME ZONE $1::text >= since
         GROUP BY 1
     )
     SELECT to_char(periods.p, 'YYYY-MM-DD') AS period,
            coalesce(ev.searches, 0) AS searches,
            coalesce(sv.saved, 0) AS saved,
            coalesce(act.time_ms, 0) AS "timeMs"
       FROM periods
       LEFT JOIN ev USING (p)
       LEFT JOIN sv USING (p)
       LEFT JOIN act USING (p)
      ORDER BY periods.p`,
    [timezone, unit, count, userId],
  );
  return rows;
}

export async function totals(userId: string, timezone: string) {
  const { rows } = await query<{
    totalSearches: number;
    uniqueTopics: number;
    savedCount: number;
    favoriteCount: number;
    totalTimeMs: number;
    researchTimeMs: number;
    readingTimeMs: number;
    totalSources: number;
    avgResearchMs: number;
    thisWeek: number;
    lastWeek: number;
    thisMonth: number;
    lastMonth: number;
    timeThisWeekMs: number;
    timeLastWeekMs: number;
    avgCredibility: number | null;
  }>(
    `WITH b AS (
        SELECT date_trunc('week', now() AT TIME ZONE $1::text) AT TIME ZONE $1::text AS week_start,
               (date_trunc('week', now() AT TIME ZONE $1::text) - interval '1 week') AT TIME ZONE $1::text AS prev_week_start,
               date_trunc('month', now() AT TIME ZONE $1::text) AT TIME ZONE $1::text AS month_start,
               (date_trunc('month', now() AT TIME ZONE $1::text) - interval '1 month') AT TIME ZONE $1::text AS prev_month_start
     ),
     e AS (SELECT created_at FROM search_events WHERE user_id = $2 AND status = 'completed'),
     a AS (SELECT created_at, duration_ms FROM activity_log WHERE user_id = $2)
     SELECT us.total_searches   AS "totalSearches",
            us.unique_topics    AS "uniqueTopics",
            us.saved_count      AS "savedCount",
            us.favorite_count   AS "favoriteCount",
            us.total_time_ms    AS "totalTimeMs",
            us.research_time_ms AS "researchTimeMs",
            us.reading_time_ms  AS "readingTimeMs",
            us.total_sources    AS "totalSources",
            us.avg_research_ms  AS "avgResearchMs",
            (SELECT count(*) FROM e, b WHERE created_at >= week_start)::int AS "thisWeek",
            (SELECT count(*) FROM e, b WHERE created_at >= prev_week_start AND created_at < week_start)::int AS "lastWeek",
            (SELECT count(*) FROM e, b WHERE created_at >= month_start)::int AS "thisMonth",
            (SELECT count(*) FROM e, b WHERE created_at >= prev_month_start AND created_at < month_start)::int AS "lastMonth",
            (SELECT coalesce(sum(duration_ms), 0) FROM a, b WHERE created_at >= week_start)::float8 AS "timeThisWeekMs",
            (SELECT coalesce(sum(duration_ms), 0) FROM a, b WHERE created_at >= prev_week_start AND created_at < week_start)::float8 AS "timeLastWeekMs",
            (SELECT avg((src->>'credibility')::float8)
               FROM searches s, jsonb_array_elements(s.sources) AS src
              WHERE s.user_id = $2) AS "avgCredibility"
       FROM user_stats us
      WHERE us.user_id = $2`,
    [timezone, userId],
  );
  return rows[0];
}

/** Distinct local days with activity in the last ~400 days, newest first (for streaks). */
export async function activeDays(userId: string, timezone: string): Promise<string[]> {
  const { rows } = await query<{ day: string }>(
    `SELECT DISTINCT to_char(created_at AT TIME ZONE $1::text, 'YYYY-MM-DD') AS day
       FROM search_events
      WHERE user_id = $2 AND status = 'completed' AND created_at > now() - interval '400 days'
      ORDER BY day DESC`,
    [timezone, userId],
  );
  return rows.map((row) => row.day);
}

export async function hourlyDistribution(userId: string, timezone: string): Promise<{ hour: number; count: number }[]> {
  const { rows } = await query<{ hour: number; count: number }>(
    `SELECT h AS hour, coalesce(c.count, 0) AS count
       FROM generate_series(0, 23) AS h
       LEFT JOIN (
         SELECT extract(hour FROM created_at AT TIME ZONE $1::text)::int AS hour, count(*)::int AS count
           FROM search_events
          WHERE user_id = $2 AND status = 'completed' AND created_at > now() - interval '180 days'
          GROUP BY 1
       ) c ON c.hour = h
      ORDER BY h`,
    [timezone, userId],
  );
  return rows;
}

export async function categoryDistribution(userId: string): Promise<{ category: string; count: number }[]> {
  const { rows } = await query<{ category: string; count: number }>(
    `SELECT coalesce(category, 'other') AS category, count(*)::int AS count
       FROM search_events
      WHERE user_id = $1 AND status = 'completed'
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 8`,
    [userId],
  );
  return rows;
}

export async function topTopics(userId: string, limit: number) {
  const { rows } = await query<{
    topic: string;
    count: number;
    lastSearchedAt: string;
    category: string | null;
    savedSearchId: string | null;
    latestEventId: string;
  }>(
    `SELECT t.topic, t.count, t.last_searched_at AS "lastSearchedAt", t.category,
            saved.id AS "savedSearchId", t.latest_event_id AS "latestEventId"
       FROM (
         SELECT normalized_topic,
                (array_agg(topic ORDER BY created_at DESC))[1] AS topic,
                (array_agg(category ORDER BY created_at DESC))[1] AS category,
                (array_agg(id ORDER BY created_at DESC))[1] AS latest_event_id,
                count(*)::int AS count,
                max(created_at) AS last_searched_at
           FROM search_events
          WHERE user_id = $1 AND status = 'completed'
          GROUP BY normalized_topic
       ) t
       LEFT JOIN LATERAL (
         SELECT id FROM searches s
          WHERE s.user_id = $1 AND s.normalized_topic = t.normalized_topic
          ORDER BY created_at DESC LIMIT 1
       ) saved ON true
      ORDER BY t.count DESC, t.last_searched_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function sourceTypeDistribution(userId: string): Promise<{ type: string; count: number }[]> {
  const { rows } = await query<{ type: string; count: number }>(
    `SELECT coalesce(src->>'type', 'other') AS type, count(*)::int AS count
       FROM searches, jsonb_array_elements(sources) AS src
      WHERE user_id = $1
      GROUP BY 1
      ORDER BY 2 DESC`,
    [userId],
  );
  return rows;
}
