import { Router } from 'express';
import { z } from 'zod';
import { CATEGORIES } from '../services/research/types.js';
import { currentUser } from '../middleware/auth.js';
import { ApiError, parseOrThrow } from '../middleware/errors.js';
import {
  deleteSearch,
  listSearches,
  openSearch,
  saveFromEvent,
  updateSearch,
} from '../repositories/searches.repository.js';

export const searchesRouter = Router();

const IdParam = z.object({ id: z.uuid() });
const Tags = z.array(z.string().trim().min(1).max(40)).max(12);

/** POST /api/searches { eventId, tags? } — "Guardar": persists a research result. */
searchesRouter.post('/', async (req, res) => {
  const body = parseOrThrow(z.object({ eventId: z.uuid(), tags: Tags.default([]) }), req.body);
  const saved = await saveFromEvent(currentUser(req).id, body.eventId, body.tags);
  if (!saved) throw new ApiError(404, 'not_found', 'Research result not found');
  res.status(saved.created ? 201 : 200).json(saved.search);
});

/** GET /api/searches?q=&category=&favorite=&sort=&limit=&offset= */
searchesRouter.get('/', async (req, res) => {
  const filters = parseOrThrow(
    z.object({
      q: z.string().trim().max(200).optional(),
      category: z.enum(CATEGORIES).optional(),
      favorite: z
        .enum(['true', 'false'])
        .optional()
        .transform((value) => value === 'true'),
      sort: z.enum(['recent', 'oldest', 'views', 'title']).default('recent'),
      limit: z.coerce.number().int().min(1).max(100).default(24),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    req.query,
  );
  res.json(await listSearches(currentUser(req).id, { ...filters, q: filters.q || undefined }));
});

/** GET /api/searches/:id — full saved research (counts as a visit). */
searchesRouter.get('/:id', async (req, res) => {
  const { id } = parseOrThrow(IdParam, req.params);
  const search = await openSearch(currentUser(req).id, id);
  if (!search) throw new ApiError(404, 'not_found', 'Saved search not found');
  res.json(search);
});

/** PATCH /api/searches/:id { isFavorite?, tags? } */
searchesRouter.patch('/:id', async (req, res) => {
  const { id } = parseOrThrow(IdParam, req.params);
  const changes = parseOrThrow(z.object({ isFavorite: z.boolean().optional(), tags: Tags.optional() }), req.body);
  const updated = await updateSearch(currentUser(req).id, id, changes);
  if (!updated) throw new ApiError(404, 'not_found', 'Saved search not found');
  res.json(updated);
});

/** DELETE /api/searches/:id */
searchesRouter.delete('/:id', async (req, res) => {
  const { id } = parseOrThrow(IdParam, req.params);
  if (!(await deleteSearch(currentUser(req).id, id))) throw new ApiError(404, 'not_found', 'Saved search not found');
  res.status(204).end();
});
