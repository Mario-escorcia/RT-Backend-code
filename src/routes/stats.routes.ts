import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth.js';
import { parseOrThrow } from '../middleware/errors.js';
import { listRecentEvents } from '../repositories/events.repository.js';
import { listSearches } from '../repositories/searches.repository.js';
import {
  activeDays,
  categoryDistribution,
  hourlyDistribution,
  periodSeries,
  sourceTypeDistribution,
  topTopics,
  totals,
} from '../repositories/stats.repository.js';

export const statsRouter = Router();

const Timezone = z
  .string()
  .default('UTC')
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown timezone');

const DAY_MS = 86_400_000;

function localToday(timezone: string): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

function computeStreaks(daysDesc: string[], timezone: string) {
  const numbers = daysDesc.map(dayNumber);
  const today = dayNumber(localToday(timezone));

  let current = 0;
  if (numbers.length && today - numbers[0] <= 1) {
    current = 1;
    for (let i = 1; i < numbers.length && numbers[i - 1] - numbers[i] === 1; i++) current++;
  }

  let longest = 0;
  let run = 0;
  for (let i = 0; i < numbers.length; i++) {
    run = i > 0 && numbers[i - 1] - numbers[i] === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return { current, longest, activeDaysLast30: numbers.filter((n) => today - n < 30).length };
}

/** GET /api/stats/overview?tz=America/Bogota — everything the dashboard needs in one call. */
statsRouter.get('/overview', async (req, res) => {
  const { tz } = parseOrThrow(z.object({ tz: Timezone }), req.query);
  const userId = currentUser(req).id;

  const [summary, days, daily, weekly, monthly, hourly, categories, topics, sourceTypes, recentEvents, recentSaved, favorites] =
    await Promise.all([
      totals(userId, tz),
      activeDays(userId, tz),
      periodSeries(userId, tz, 'day', 182),
      periodSeries(userId, tz, 'week', 12),
      periodSeries(userId, tz, 'month', 12),
      hourlyDistribution(userId, tz),
      categoryDistribution(userId),
      topTopics(userId, 8),
      sourceTypeDistribution(userId),
      listRecentEvents(userId, 8),
      listSearches(userId, { sort: 'recent', limit: 6, offset: 0 }),
      listSearches(userId, { sort: 'views', favorite: true, limit: 6, offset: 0 }),
    ]);

  res.json({
    timezone: tz,
    totals: summary,
    streak: computeStreaks(days, tz),
    daily,
    weekly,
    monthly,
    hourly,
    categories,
    topTopics: topics,
    sourceTypes,
    recentEvents,
    recentSaved: recentSaved.items,
    favorites: favorites.items,
  });
});
