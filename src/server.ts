import { createApp } from './app.js';
import { env, researchProvider } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { pool } from './db/pool.js';

async function main() {
  try {
    await runMigrations();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ECONNREFUSED' || code === '28P01') {
      console.error(
        `Cannot connect to PostgreSQL (${code}). Check that the server is running and DATABASE_URL in backend/.env is correct.`,
      );
    } else {
      console.error('Database setup failed:', error);
    }
    process.exit(1);
  }

  const server = createApp().listen(env.PORT, () => {
    console.log(`Knowledge Hub API listening on http://localhost:${env.PORT}`);
    console.log(
      `Research provider: ${researchProvider}${researchProvider === 'claude' ? ` (${env.ANTHROPIC_MODEL})` : ' (Wikipedia + OpenAlex)'}`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    // Open SSE streams keep the server alive; force-exit after a grace period.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
