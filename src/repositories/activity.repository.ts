import { query } from '../db/pool.js';

/** Logs research/reading time. Referenced ids are only linked when they belong to the same user. */
export async function logActivity(
  userId: string,
  kind: 'research' | 'reading',
  durationMs: number,
  refs: { eventId?: string | null; searchId?: string | null } = {},
): Promise<void> {
  await query(
    `INSERT INTO activity_log (user_id, kind, duration_ms, event_id, search_id)
     VALUES ($1, $2, $3,
             (SELECT id FROM search_events WHERE id = $4 AND user_id = $1),
             (SELECT id FROM searches WHERE id = $5 AND user_id = $1))`,
    [userId, kind, Math.max(0, Math.round(durationMs)), refs.eventId ?? null, refs.searchId ?? null],
  );
}
