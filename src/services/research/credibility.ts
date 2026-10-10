import { domainOf } from '../../lib/text.js';
import type { SourceType } from './types.js';

/**
 * Domain-based credibility heuristic (0-100). It is a transparent signal, not a fact check:
 * official, academic and international bodies rank highest, established newsrooms next.
 */
const ACADEMIC = [
  'nature.com', 'science.org', 'sciencedirect.com', 'springer.com', 'wiley.com', 'thelancet.com', 'nejm.org',
  'bmj.com', 'cell.com', 'plos.org', 'pnas.org', 'jstor.org', 'ieee.org', 'acm.org', 'tandfonline.com',
  'sagepub.com', 'oup.com', 'cambridge.org', 'frontiersin.org', 'mdpi.com', 'jamanetwork.com',
  'annualreviews.org', 'acs.org', 'aps.org', 'iop.org', 'royalsocietypublishing.org', 'ncbi.nlm.nih.gov',
  'scielo.org', 'redalyc.org', 'dialnet.unirioja.es', 'semanticscholar.org', 'openalex.org', 'doi.org',
  'cochranelibrary.com', 'elifesciences.org', 'aaas.org',
];
const PREPRINTS = ['arxiv.org', 'biorxiv.org', 'medrxiv.org', 'ssrn.com', 'researchgate.net', 'osf.io'];
const INTERNATIONAL = [
  'who.int', 'un.org', 'unesco.org', 'unicef.org', 'worldbank.org', 'imf.org', 'oecd.org', 'wto.org', 'ilo.org',
  'fao.org', 'undp.org', 'unep.org', 'iea.org', 'irena.org', 'ipcc.ch', 'europa.eu', 'cepal.org', 'iadb.org',
  'bis.org', 'iaea.org', 'wmo.int', 'itu.int', 'paho.org', 'unhcr.org', 'wfp.org', 'caf.com', 'nato.int',
];
const REFERENCE: Record<string, number> = {
  'ourworldindata.org': 92, 'data.worldbank.org': 95, 'gapminder.org': 86, 'pewresearch.org': 88,
  'britannica.com': 86, 'statista.com': 80, 'gallup.com': 82, 'wikipedia.org': 72, 'wikidata.org': 70,
  'wikimedia.org': 80, 'wmcloud.org': 80, 'rae.es': 90, 'merriam-webster.com': 82, 'nationalgeographic.com': 78,
  'smithsonianmag.com': 80, 'investopedia.com': 70, 'history.com': 68, 'mayoclinic.org': 88,
  'clevelandclinic.org': 86, 'hopkinsmedicine.org': 88, 'cancer.org': 86, 'khanacademy.org': 78,
};
const NEWS = [
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com', 'washingtonpost.com',
  'wsj.com', 'ft.com', 'economist.com', 'bloomberg.com', 'npr.org', 'aljazeera.com', 'dw.com', 'lemonde.fr',
  'elpais.com', 'elmundo.es', 'lavanguardia.com', 'eltiempo.com', 'clarin.com', 'lanacion.com.ar',
  'infobae.com', 'cnn.com', 'cnbc.com', 'axios.com', 'politico.com', 'time.com', 'theatlantic.com',
  'newscientist.com', 'scientificamerican.com', 'technologyreview.com', 'nationalpost.com', 'afp.com',
  'efe.com', 'france24.com', 'elespectador.com', 'semana.com', 'eluniversal.com.mx', 'expansion.com',
  'forbes.com', 'fortune.com', 'wired.com', 'arstechnica.com', 'theverge.com', 'techcrunch.com',
];

const GOVERNMENT_PATTERN = /(^|\.)(gov|gob|gouv|gc|mil|govt|go|gub|bund)(\.[a-z]{2})?$|\.gov\.[a-z]{2}$|\.gob\.[a-z]{2}$/;
const ACADEMIC_TLD_PATTERN = /(^|\.)(edu|ac)(\.[a-z]{2})?$|\.edu\.[a-z]{2}$|\.ac\.[a-z]{2}$/;

function matches(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function assessSource(url: string, hintedType?: SourceType): { domain: string; type: SourceType; credibility: number } {
  const domain = domainOf(url);

  if (matches(domain, INTERNATIONAL)) return { domain, type: 'international', credibility: 94 };
  if (GOVERNMENT_PATTERN.test(domain) || domain.endsWith('.gov')) return { domain, type: 'government', credibility: 95 };
  if (matches(domain, ACADEMIC)) return { domain, type: 'academic', credibility: 91 };
  if (ACADEMIC_TLD_PATTERN.test(domain)) return { domain, type: 'academic', credibility: 88 };
  if (matches(domain, PREPRINTS)) return { domain, type: 'academic', credibility: 76 };

  const reference = Object.entries(REFERENCE).find(([ref]) => domain === ref || domain.endsWith(`.${ref}`));
  if (reference) return { domain, type: 'reference', credibility: reference[1] };
  if (matches(domain, NEWS)) return { domain, type: 'news', credibility: 80 };

  if (hintedType === 'industry') return { domain, type: 'industry', credibility: 62 };
  if (hintedType === 'news') return { domain, type: 'news', credibility: 64 };
  if (domain.endsWith('.org')) return { domain, type: hintedType ?? 'organization', credibility: 68 };
  return { domain, type: hintedType ?? 'other', credibility: 55 };
}
