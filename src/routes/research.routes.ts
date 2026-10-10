import { Router, type RequestHandler, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env, researchProvider } from '../config/env.js';
import { logActivity } from '../repositories/activity.repository.js';
import { createCompletedEvent, createFailedEvent } from '../repositories/events.repository.js';
import { ResearchError, runResearch } from '../services/research/index.js';

export const researchRouter = Router();

const ResearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  lang: z.enum(['es', 'en']).default('es'),
});

function openEventStream(res: Response) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  return (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// EventSource cannot read error bodies, so auth, limits and validation errors are sent as SSE events.
const requireAuthStream: RequestHandler = (req, res, next) => {
  if (req.user) return next();
  const send = openEventStream(res);
  send('error', { code: 'unauthorized', message: 'Authentication required.' });
  res.end();
};

// Per user (cost guard for the AI provider).
const researchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.RESEARCH_RATE_LIMIT_PER_HOUR,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  handler: (_req, res) => {
    const send = openEventStream(res);
    send('error', { code: 'rate_limited', message: 'Too many research requests, try again later.' });
    res.end();
  },
});

/**
 * GET /api/research/stream?q=topic&lang=es
 * Server-Sent Events: `progress` (stage updates, queries, sources found), then `result` or `error`.
 */
researchRouter.get('/stream', requireAuthStream, researchLimiter, async (req, res) => {
  const parsed = ResearchQuery.safeParse(req.query);
  const send = openEventStream(res);
  if (!parsed.success) {
    send('error', { code: 'invalid_query', message: 'The topic must have between 2 and 200 characters.' });
    res.end();
    return;
  }

  const userId = req.user!.id;
  const { q: topic, lang } = parsed.data;
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 15_000);
  const startedAt = Date.now();

  try {
    const result = await runResearch({
      topic,
      lang,
      signal: controller.signal,
      onProgress: (progress) => send('progress', progress),
    });
    const eventId = await createCompletedEvent(userId, topic, lang, result);
    await logActivity(userId, 'research', result.meta.researchMs, { eventId });
    send('result', { eventId, savedSearchId: null, result });
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    if (controller.signal.aborted) {
      await createFailedEvent(userId, topic, lang, researchProvider, 'cancelled', elapsed, null).catch(() => undefined);
    } else {
      console.error('Research failed:', error);
      await createFailedEvent(userId, topic, lang, researchProvider, 'failed', elapsed, (error as Error).message).catch(
        () => undefined,
      );
      send('error', {
        code: error instanceof ResearchError ? error.code : 'internal_error',
        message: error instanceof ResearchError ? error.message : 'Research failed unexpectedly.',
      });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});
