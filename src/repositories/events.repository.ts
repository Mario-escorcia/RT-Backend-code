import { query } from '../db/pool.js';
import { normalizeTopic } from '../lib/text.js';
import type { Lang, ResearchResult } from '../services/research/types.js';

export interface EventSummary {
  id: string;
  topic: string;
  category: string | null;
  language: Lang;
  provider: string;
  status: string;
  researchMs: number;
  sourceCount: number;
  createdAt: string;
  savedSearchId: string | null;
}

const SUMMARY_COLUMNS = `
  e.id, e.topic, e.category, e.language, e.provider, e.status,
  e.research_ms AS "researchMs", e.source_count AS "sourceCount", e.created_at AS "createdAt",
  s.id AS "savedSearchId"`;

export async function createCompletedEvent(userId: string, topic: string, lang: Lang, result: ResearchResult): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO search_events (user_id, topic, normalized_topic, language, provider, status, category, research_ms, source_count, result)
     VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8, $9)
     RETURNING id`,
    [
      userId,
      topic,
      normalizeTopic(topic),
      lang,
      result.meta.provider,
      result.report.category,
      result.meta.researchMs,
      result.meta.sourceCount,
      JSON.stringify(result),
    ],
  );
  return rows[0].id;
}

export async function createFailedEvent(
  userId: string,
  topic: string,
  lang: Lang,
  provider: string,
  status: 'failed' | 'cancelled',
  researchMs: number,
  error: string | null,
): Promise<void> {
  await query(
    `INSERT INTO search_events (user_id, topic, normalized_topic, language, provider, status, research_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, topic, normalizeTopic(topic), lang, provider, status, researchMs, error],
  );
}

export async function listRecentEvents(userId: string, limit: number): Promise<EventSummary[]> {
  const { rows } = await query<EventSummary>(
    `SELECT ${SUMMARY_COLUMNS}
       FROM search_events e
       LEFT JOIN searches s ON s.event_id = e.id
      WHERE e.user_id = $1 AND e.status = 'completed'
      ORDER BY e.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function getEvent(userId: string, id: string): Promise<(EventSummary & { result: ResearchResult | null }) | null> {
  const { rows } = await query<EventSummary & { result: ResearchResult | null }>(
    `SELECT ${SUMMARY_COLUMNS}, e.result
       FROM search_events e
       LEFT JOIN searches s ON s.event_id = e.id
      WHERE e.id = $1 AND e.user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}
