import { query } from '../db/pool.js';
import { normalizeTopic } from '../lib/text.js';
import type { ResearchResult } from '../services/research/types.js';

export interface SavedSearchSummary {
  id: string;
  topic: string;
  title: string;
  category: string | null;
  language: string;
  summary: string;
  tldr: string | null;
  tags: string[];
  provider: string;
  isFavorite: boolean;
  viewCount: number;
  sourceCount: number;
  chartCount: number;
  metricCount: number;
  createdAt: string;
  updatedAt: string;
  lastViewedAt: string | null;
}

export interface SavedSearch extends SavedSearchSummary {
  eventId: string | null;
  rawData: ResearchResult;
}

const SUMMARY_COLUMNS = `
  id, topic, coalesce(raw_data->'report'->>'title', topic) AS title, category, language,
  summary, raw_data->'report'->>'tldr' AS tldr, tags, provider,
  is_favorite AS "isFavorite", view_count AS "viewCount",
  jsonb_array_length(sources) AS "sourceCount",
  coalesce(jsonb_array_length(raw_data->'report'->'charts'), 0)
    + (CASE WHEN jsonb_typeof(raw_data->'enrichment'->'interest') = 'object' THEN 1 ELSE 0 END)
    + (CASE WHEN jsonb_typeof(raw_data->'enrichment'->'academic') = 'object' THEN 1 ELSE 0 END) AS "chartCount",
  coalesce(jsonb_array_length(raw_data->'report'->'metrics'), 0) AS "metricCount",
  created_at AS "createdAt", updated_at AS "updatedAt", last_viewed_at AS "lastViewedAt"`;

/** Saves the research stored in one of the user's search events. Idempotent. */
export async function saveFromEvent(
  userId: string,
  eventId: string,
  tags: string[],
): Promise<{ search: SavedSearchSummary; created: boolean } | null> {
  const existing = await query<{ id: string }>('SELECT id FROM searches WHERE event_id = $1 AND user_id = $2', [
    eventId,
    userId,
  ]);
  if (existing.rows[0]) {
    return { search: (await getSummary(userId, existing.rows[0].id))!, created: false };
  }

  const event = await query<{ topic: string; language: string; provider: string; result: ResearchResult | null }>(
    `SELECT topic, language, provider, result FROM search_events
      WHERE id = $1 AND user_id = $2 AND status = 'completed'`,
    [eventId, userId],
  );
  const row = event.rows[0];
  if (!row?.result) return null;

  const result = row.result;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO searches (user_id, event_id, topic, normalized_topic, language, category, summary, raw_data, sources, tags, provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
     RETURNING id`,
    [
      userId,
      eventId,
      row.topic,
      normalizeTopic(row.topic),
      row.language,
      result.report.category,
      result.report.summary,
      JSON.stringify(result),
      JSON.stringify(result.sources),
      tags,
      row.provider,
    ],
  );
  return { search: (await getSummary(userId, rows[0].id))!, created: true };
}

export async function getSummary(userId: string, id: string): Promise<SavedSearchSummary | null> {
  const { rows } = await query<SavedSearchSummary>(`SELECT ${SUMMARY_COLUMNS} FROM searches WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  return rows[0] ?? null;
}

/** Returns a saved search and registers the visit. */
export async function openSearch(userId: string, id: string): Promise<SavedSearch | null> {
  const { rows } = await query<SavedSearch>(
    `UPDATE searches SET view_count = view_count + 1, last_viewed_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING ${SUMMARY_COLUMNS}, event_id AS "eventId", raw_data AS "rawData"`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export interface ListFilters {
  q?: string;
  category?: string;
  favorite?: boolean;
  sort: 'recent' | 'oldest' | 'views' | 'title';
  limit: number;
  offset: number;
}

// Applied on the aliased sub-select, hence the quoted camelCase names.
const ORDER_BY: Record<ListFilters['sort'], string> = {
  recent: '"createdAt" DESC',
  oldest: '"createdAt" ASC',
  views: '"viewCount" DESC, "createdAt" DESC',
  title: 'lower(title) ASC',
};

export async function listSearches(userId: string, filters: ListFilters) {
  const params: unknown[] = [userId];
  const where: string[] = ['user_id = $1'];
  if (filters.q) {
    params.push(filters.q);
    const textParam = `$${params.length}`;
    params.push(`%${filters.q}%`);
    where.push(
      `(search_vector @@ websearch_to_tsquery('simple', ${textParam}) OR topic ILIKE $${params.length} OR ${textParam} = ANY(tags))`,
    );
  }
  if (filters.category) {
    params.push(filters.category);
    where.push(`category = $${params.length}`);
  }
  if (filters.favorite) where.push('is_favorite');
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const countResult = await query<{ total: number }>(`SELECT count(*)::int AS total FROM searches ${whereSql}`, params);
  const pageParams = [...params, filters.limit, filters.offset];
  const { rows } = await query<SavedSearchSummary>(
    `SELECT * FROM (SELECT ${SUMMARY_COLUMNS} FROM searches ${whereSql}) AS listed
      ORDER BY ${ORDER_BY[filters.sort]}
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );
  const facets = await query<{ category: string; count: number }>(
    `SELECT coalesce(category, 'other') AS category, count(*)::int AS count
       FROM searches WHERE user_id = $1 GROUP BY 1 ORDER BY 2 DESC`,
    [userId],
  );
  return { items: rows, total: countResult.rows[0].total, categories: facets.rows };
}

export async function updateSearch(userId: string, id: string, changes: { isFavorite?: boolean; tags?: string[] }) {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (changes.isFavorite !== undefined) {
    params.push(changes.isFavorite);
    sets.push(`is_favorite = $${params.length}`);
  }
  if (changes.tags !== undefined) {
    params.push(changes.tags);
    sets.push(`tags = $${params.length}`);
  }
  if (!sets.length) return getSummary(userId, id);
  params.push(id, userId);
  const { rowCount } = await query(
    `UPDATE searches SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND user_id = $${params.length}`,
    params,
  );
  return rowCount ? getSummary(userId, id) : null;
}

export async function deleteSearch(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM searches WHERE id = $1 AND user_id = $2', [id, userId]);
  return Boolean(rowCount);
}
