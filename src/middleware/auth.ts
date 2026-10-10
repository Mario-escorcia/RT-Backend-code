import type { Request, RequestHandler, Response } from 'express';
import { cookieSecure, corsOrigins, env } from '../config/env.js';
import { findSessionUser, touchSession } from '../repositories/users.repository.js';
import { hashToken } from '../services/auth.service.js';
import { ApiError } from './errors.js';

export const SESSION_COOKIE = 'kh_session';
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const cookieOptions = () => ({
  httpOnly: true,
  secure: cookieSecure,
  sameSite: 'none' as const,
  path: '/',
});

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: env.SESSION_DAYS * 24 * 60 * 60 * 1000 });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/** Resolves the session cookie into `req.user` (never rejects the request by itself). */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const tokenHash = hashToken(token);
    const session = await findSessionUser(tokenHash);
    if (session) {
      const { sessionId, lastSeenAt, ...user } = session;
      req.user = user;
      req.sessionTokenHash = tokenHash;
      if (Date.now() - new Date(lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
        touchSession(sessionId).catch(() => undefined);
      }
    }
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) throw new ApiError(401, 'unauthorized', 'Authentication required');
  next();
};

/** Returns the authenticated user or throws 401 (for handlers mounted behind requireAuth). */
export function currentUser(req: Request) {
  if (!req.user) throw new ApiError(401, 'unauthorized', 'Authentication required');
  return req.user;
}

/**
 * CSRF defence in depth (cookies are already SameSite=Lax): state-changing requests that carry
 * an Origin header must come from this site or an allowed CORS origin.
 */
export const verifyOrigin: RequestHandler = (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (!origin || corsOrigins.includes(origin)) return next();
  try {
    if (new URL(origin).host === req.get('host')) return next();
  } catch {
    /* malformed origin */
  }
  throw new ApiError(403, 'forbidden_origin', 'Cross-site request rejected');
};
