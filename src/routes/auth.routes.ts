import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env.js';
import { clearSessionCookie, setSessionCookie } from '../middleware/auth.js';
import { ApiError, parseOrThrow } from '../middleware/errors.js';
import {
  claimLegacyDataIfFirstUser,
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  findUserByEmail,
  touchLogin,
} from '../repositories/users.repository.js';
import { burnPasswordCheck, hashPassword, newSessionToken, verifyPassword } from '../services/auth.service.js';

export const authRouter = Router();

// Brute-force guard for credential endpoints.
const credentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts, try again in a few minutes.' },
});

const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));
const Password = z.string().min(8).max(128);

async function startSession(userId: string, userAgent: string | undefined) {
  const { token, tokenHash } = newSessionToken();
  await createSession(userId, tokenHash, userAgent, env.SESSION_DAYS);
  return token;
}

/** GET /api/auth/config — public settings the login screen needs. */
authRouter.get('/config', (_req, res) => {
  res.json({ registrationOpen: env.ALLOW_REGISTRATION });
});

/** POST /api/auth/register { name, email, password } */
authRouter.post('/register', credentialsLimiter, async (req, res) => {
  if (!env.ALLOW_REGISTRATION) throw new ApiError(403, 'registration_closed', 'Registration is disabled');
  const body = parseOrThrow(z.object({ name: z.string().trim().min(1).max(80), email: Email, password: Password }), req.body);

  const user = await createUser(body.name, body.email, await hashPassword(body.password));
  if (!user) throw new ApiError(409, 'email_taken', 'An account with this e-mail already exists');

  await claimLegacyDataIfFirstUser(user.id);
  setSessionCookie(res, await startSession(user.id, req.get('user-agent')));
  await touchLogin(user.id);
  res.status(201).json(user);
});

/** POST /api/auth/login { email, password } */
authRouter.post('/login', credentialsLimiter, async (req, res) => {
  const body = parseOrThrow(z.object({ email: Email, password: z.string().min(1).max(128) }), req.body);

  const found = await findUserByEmail(body.email);
  if (!found) {
    await burnPasswordCheck(body.password);
    throw new ApiError(401, 'invalid_credentials', 'Invalid e-mail or password');
  }
  const { passwordHash, ...user } = found;
  if (!(await verifyPassword(body.password, passwordHash))) {
    throw new ApiError(401, 'invalid_credentials', 'Invalid e-mail or password');
  }

  await deleteExpiredSessions();
  setSessionCookie(res, await startSession(user.id, req.get('user-agent')));
  await touchLogin(user.id);
  res.json(user);
});

/** POST /api/auth/logout */
authRouter.post('/logout', async (req, res) => {
  if (req.sessionTokenHash) await deleteSession(req.sessionTokenHash);
  clearSessionCookie(res);
  res.status(204).end();
});

/** GET /api/auth/me — the signed-in user, or 401. */
authRouter.get('/me', (req, res) => {
  if (!req.user) throw new ApiError(401, 'unauthorized', 'Not signed in');
  res.json(req.user);
});
