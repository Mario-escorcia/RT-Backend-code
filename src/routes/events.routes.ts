import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth.js';
import { ApiError, parseOrThrow } from '../middleware/errors.js';
import { getEvent, listRecentEvents } from '../repositories/events.repository.js';

export const eventsRouter = Router();

const IdParam = z.object({ id: z.uuid() });

/** GET /api/events?limit=10 — the user's latest research runs (saved or not). */
eventsRouter.get('/', async (req, res) => {
  const { limit } = parseOrThrow(z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }), req.query);
  res.json(await listRecentEvents(currentUser(req).id, limit));
});

/** GET /api/events/:id — full result of a past research, so it can be reopened without searching again. */
eventsRouter.get('/:id', async (req, res) => {
  const { id } = parseOrThrow(IdParam, req.params);
  const event = await getEvent(currentUser(req).id, id);
  if (!event?.result) throw new ApiError(404, 'not_found', 'Research not found');
  res.json({ eventId: event.id, savedSearchId: event.savedSearchId, result: event.result });
});
