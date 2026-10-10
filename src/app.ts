import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cookieSecure, corsOrigins, env, researchProvider, trustProxy } from './config/env.js';
import { pool } from './db/pool.js';
import { authenticate, requireAuth, verifyOrigin } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { activityRouter } from './routes/activity.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { eventsRouter } from './routes/events.routes.js';
import { researchRouter } from './routes/research.routes.js';
import { searchesRouter } from './routes/searches.routes.js';
import { statsRouter } from './routes/stats.routes.js';

/** Hashed build files (main-AB12CD34.js) can be cached forever; everything else is revalidated. */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/;

function frontendDirectory(): string | null {
  if (!env.FRONTEND_DIST) return null;
  const directory = path.resolve(env.FRONTEND_DIST);
  if (existsSync(path.join(directory, 'index.html'))) return directory;
  console.warn(`FRONTEND_DIST is set but ${directory}/index.html was not found; serving the API only.`);
  return null;
}

function serveFrontend(app: Express, directory: string) {
  app.use(
    express.static(directory, {
      index: false,
      cacheControl: false,
      setHeaders: (res, file) => {
        res.setHeader(
          'Cache-Control',
          HASHED_ASSET.test(path.basename(file)) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );
  // SPA fallback: every non-API GET returns index.html and Angular's router takes over.
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(directory, 'index.html'));
  });
}

export function createApp() {
  const app = express();
  const frontend = frontendDirectory();

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Angular injects component styles at runtime; fonts come from Google Fonts.
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          // Wikipedia thumbnails and source favicons.
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          // Over plain HTTP (testing by IP) upgrading would break every request.
          upgradeInsecureRequests: cookieSecure ? [] : null,
        },
      },
      strictTransportSecurity: cookieSecure,
    }),
  );
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', authenticate, verifyOrigin);

  app.get('/api/health', async (_req, res) => {
    let database: 'up' | 'down' = 'up';
    try {
      await pool.query('SELECT 1');
    } catch {
      database = 'down';
    }
    res.status(database === 'up' ? 200 : 503).json({
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      provider: researchProvider,
      model: researchProvider === 'claude' ? env.ANTHROPIC_MODEL : null,
    });
  });

  app.use('/api/auth', authRouter);
  // The research stream answers unauthenticated requests with an SSE error event itself.
  app.use('/api/research', researchRouter);
  app.use('/api/events', requireAuth, eventsRouter);
  app.use('/api/searches', requireAuth, searchesRouter);
  app.use('/api/activity', requireAuth, activityRouter);
  app.use('/api/stats', requireAuth, statsRouter);

  if (frontend) serveFrontend(app, frontend);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
