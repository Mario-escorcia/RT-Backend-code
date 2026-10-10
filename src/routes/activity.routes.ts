import express, { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth.js';
import { ApiError, parseOrThrow } from '../middleware/errors.js';
import { logActivity } from '../repositories/activity.repository.js';

export const activityRouter = Router();

const MAX_READING_MS = 4 * 60 * 60 * 1000;

/**
 * POST /api/activity { durationMs, eventId?, searchId? }
 * Reading time reported by the client. Accepts text/plain too, because navigator.sendBeacon
 * (used when the tab closes) can only send CORS-safelisted content types.
 */
activityRouter.post('/', express.text({ type: 'text/plain', limit: '4kb' }), async (req, res) => {
  let payload: unknown = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new ApiError(400, 'invalid_json', 'Malformed JSON body');
    }
  }
  const body = parseOrThrow(
    z.object({
      durationMs: z.number().int().min(0),
      eventId: z.uuid().nullish(),
      searchId: z.uuid().nullish(),
    }),
    payload,
  );
  // Ignore accidental bounces; cap idle tabs left open for hours.
  if (body.durationMs >= 3_000) {
    await logActivity(currentUser(req).id, 'reading', Math.min(body.durationMs, MAX_READING_MS), body);
  }
  res.status(204).end();
});
