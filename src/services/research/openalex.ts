import { env } from '../../config/env.js';
import { fetchJson } from '../../lib/http.js';
import type { AcademicData, Category } from './types.js';

const BASE_URL = 'https://api.openalex.org/works';

interface GroupResponse {
  group_by?: { key: string; key_display_name: string; count: number }[];
}

interface WorksResponse {
  meta?: { count: number };
  results?: {
    display_name: string | null;
    publication_year: number | null;
    cited_by_count: number;
    doi: string | null;
    id: string;
    primary_location?: { source?: { display_name?: string | null } | null } | null;
  }[];
}

function url(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  if (env.OPENALEX_API_KEY) search.set('api_key', env.OPENALEX_API_KEY);
  else if (env.CONTACT_EMAIL) search.set('mailto', env.CONTACT_EMAIL);
  return `${BASE_URL}?${search}`;
}

/**
 * Academic footprint of a topic from OpenAlex (250M+ scholarly works):
 * publications per year, leading countries, research fields and most-cited works.
 */
export async function fetchAcademic(query: string, signal?: AbortSignal): Promise<AcademicData | null> {
  const currentYear = new Date().getUTCFullYear();
  // The current year is still incomplete, so the trend stops at the last full year.
  const fromYear = currentYear - 15;
  const toYear = currentYear - 1;
  const filter = `publication_year:${fromYear}-${toYear}`;
  const group = (groupBy: string) => fetchJson<GroupResponse>(url({ search: query, filter, group_by: groupBy }), { signal });

  const [years, countries, fields, top] = await Promise.allSettled([
    group('publication_year'),
    group('authorships.countries'),
    group('primary_topic.field.id'),
    fetchJson<WorksResponse>(
      url({
        search: query,
        sort: 'cited_by_count:desc',
        per_page: '5',
        select: 'id,display_name,publication_year,cited_by_count,doi,primary_location',
      }),
      { signal },
    ),
  ]);
  if (signal?.aborted) throw new Error('aborted');

  const byYear =
    years.status === 'fulfilled'
      ? (years.value.group_by ?? [])
          .map((entry) => ({ year: Number(entry.key), count: entry.count }))
          .filter((entry) => entry.year >= fromYear && entry.year <= toYear)
          .sort((a, b) => a.year - b.year)
      : [];
  const total = top.status === 'fulfilled' ? (top.value.meta?.count ?? 0) : byYear.reduce((sum, e) => sum + e.count, 0);
  if (!total && !byYear.length) return null;

  const countOf = (year: number) => byYear.find((entry) => entry.year === year)?.count ?? 0;
  const base = countOf(toYear - 5);
  const growthPct = base > 0 ? Math.round(((countOf(toYear) - base) / base) * 1000) / 10 : null;

  return {
    query,
    total,
    byYear,
    growthPct,
    countries:
      countries.status === 'fulfilled'
        ? (countries.value.group_by ?? [])
            .filter((entry) => entry.key && entry.key !== 'unknown')
            .slice(0, 10)
            .map((entry) => ({ code: entry.key.split('/').pop() ?? entry.key, name: entry.key_display_name, count: entry.count }))
        : [],
    fields:
      fields.status === 'fulfilled'
        ? (fields.value.group_by ?? [])
            .filter((entry) => entry.key && entry.key !== 'unknown')
            .slice(0, 8)
            .map((entry) => ({ name: entry.key_display_name, count: entry.count }))
        : [],
    topWorks:
      top.status === 'fulfilled'
        ? (top.value.results ?? [])
            .filter((work) => work.display_name)
            .map((work) => ({
              title: work.display_name ?? '',
              year: work.publication_year,
              citations: work.cited_by_count,
              url: work.doi ?? work.id,
              venue: work.primary_location?.source?.display_name ?? null,
            }))
        : [],
  };
}

const FIELD_CATEGORIES: [RegExp, Category][] = [
  [/medicine|health|nursing|immunology|pharmacology|dentistry|neuroscience|veterinary/i, 'health'],
  [/computer|engineering|materials/i, 'technology'],
  [/environmental|energy/i, 'environment'],
  [/economics/i, 'economy'],
  [/business|decision/i, 'business'],
  [/social|psychology/i, 'society'],
  [/arts|humanities/i, 'culture'],
  [/physics|chemistry|mathematics|biochemistry|earth|agricultural|chemical/i, 'science'],
];

export function categoryFromFields(fields: AcademicData['fields']): Category {
  const top = fields[0]?.name;
  if (!top) return 'other';
  return FIELD_CATEGORIES.find(([pattern]) => pattern.test(top))?.[1] ?? 'other';
}
