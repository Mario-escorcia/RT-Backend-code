import { query } from '../db/pool.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

const PUBLIC_COLUMNS = 'u.id, u.name, u.email, u.created_at AS "createdAt"';

export async function findUserByEmail(email: string): Promise<(PublicUser & { passwordHash: string }) | null> {
  const { rows } = await query<PublicUser & { passwordHash: string }>(
    `SELECT ${PUBLIC_COLUMNS}, u.password_hash AS "passwordHash" FROM users u WHERE lower(u.email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

/** Returns null when the e-mail is already registered. */
export async function createUser(name: string, email: string, passwordHash: string): Promise<PublicUser | null> {
  try {
    const { rows } = await query<PublicUser>(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       RETURNING id, name, email, created_at AS "createdAt"`,
      [name, email, passwordHash],
    );
    return rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
}

/**
 * The very first account inherits data created before authentication was enabled,
 * so an existing single-user installation keeps its history.
 */
export async function claimLegacyDataIfFirstUser(userId: string): Promise<void> {
  const { rows } = await query<{ count: number }>('SELECT count(*)::int AS count FROM users');
  if (rows[0].count !== 1) return;
  await query('UPDATE search_events SET user_id = $1 WHERE user_id IS NULL', [userId]);
  await query('UPDATE searches SET user_id = $1 WHERE user_id IS NULL', [userId]);
  await query('UPDATE activity_log SET user_id = $1 WHERE user_id IS NULL', [userId]);
}

export async function touchLogin(userId: string): Promise<void> {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

export async function createSession(userId: string, tokenHash: string, userAgent: string | undefined, days: number) {
  await query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4::int))`,
    [userId, tokenHash, userAgent?.slice(0, 300) ?? null, days],
  );
}

export async function findSessionUser(tokenHash: string): Promise<(PublicUser & { sessionId: string; lastSeenAt: string }) | null> {
  const { rows } = await query<PublicUser & { sessionId: string; lastSeenAt: string }>(
    `SELECT ${PUBLIC_COLUMNS}, s.id AS "sessionId", s.last_seen_at AS "lastSeenAt"
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function touchSession(sessionId: string): Promise<void> {
  await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

export async function deleteExpiredSessions(): Promise<void> {
  await query('DELETE FROM sessions WHERE expires_at <= now()');
}
