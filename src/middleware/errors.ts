import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw new ApiError(400, 'validation_error', z.prettifyError(result.error));
  return result.data;
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: 'not_found', message: `Route ${req.method} ${req.path} not found` });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  if ((error as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json', message: 'Malformed JSON body' });
    return;
  }
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'internal_error', message: 'Unexpected server error' });
};
