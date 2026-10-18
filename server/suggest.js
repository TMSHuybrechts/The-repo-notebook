// Personal suggestions: fish GitHub for repos that match the shelf's taste and
// score them with the same explainable engine as the map (graph.js). "Taste"
// is the shelf weighted by status — keep ("Bevalt") counts hardest, archive
// barely — so suggestions follow what was actually liked, not just hoarded.
// Pure functions, no network: the server feeds the search candidates in.

import { buildProfile, idfMap, pairScore, vectorNorms } from "./graph.js";

// How hard a shelf repo pulls on the taste profile, by status.
const STATUS_WEIGHT = { keep: 3, installed: 2, todo: 1, archive: 0.5 };
const CLONED_BONUS = 0.5;
// Same floor as the map's MIN_EDGE_SCORE: below this a link is noise.
const MIN_LINK_SCORE = 0.06;
const MAX_LINKS = 4; // strongest own-repo links kept per suggestion
const MAX_SUGGESTIONS = 15;
const MAX_PER_OWNER = 2; // search returns sibling repos; one owner shouldn't flood
const TOPIC_QUERIES = 4;
const SEARCH_STARS_TOPIC = 25;
const SEARCH_STARS_TEXT = 40;
const PUSHED_WITHIN_DAYS = 270; // dead repos are not suggestions

export const tasteWeight = (repo) =>
  (STATUS_WEIGHT[String(repo.status || "")] ?? 1) + (repo.cloneStatus || repo.localPath ? CLONED_BONUS : 0);

// Shelf topics ranked by (status-weighted mass) × (IDF within the shelf):
// common enough to be a real interest, distinctive enough to mean something.
export const tasteTopics = (repos, limit = TOPIC_QUERIES) => {
  const documents = repos.map((repo) => [...new Set((repo.topics || []).map((t) => String(t).toLowerCase()))]);
  const idf = idfMap(documents);
  const mass = new Map();
  const count = new Map();
  repos.forEach((repo, i) => {
    const weight = tasteWeight(repo);
    for (const topic of documents[i]) {
      mass.set(topic, (mass.get(topic) || 0) + weight);
      count.set(topic, (count.get(topic) || 0) + 1);
    }
  });
  const minCount = repos.length >= 8 ? 2 : 1; // one-off topics are noise on a real shelf
  return [...mass.entries()]
    .filter(([topic]) => (count.get(topic) || 0) >= minCount)
    .map(([topic, m]) => [topic, m * (idf.get(topic) || 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([topic]) => topic);
};

// Top TF-IDF terms across the taste-weighted shelf, for one free-text query.
// Per-repo unit vectors (cosine style) so a long README doesn't dominate.
export const tasteTerms = (repos, limit = 4) => {
  const profiles = repos.map(buildProfile);
  const termIdf = idfMap(profiles.map((p) => [...p.terms.keys()]));
  const norms = vectorNorms(profiles, termIdf);
  const score = new Map();
  profiles.forEach((profile, i) => {
    const norm = norms.get(profile.id);
    if (!norm) return;
    const weight = tasteWeight(repos[i]);
    for (const [word, tf] of profile.terms) {
      score.set(word, (score.get(word) || 0) + ((tf * (termIdf.get(word) || 0)) / norm) * weight);
    }
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
};

const isoDaysBack = (days, now) => new Date(now - days * 86400000).toISOString().slice(0, 10);

// GitHub search queries that fish where the shelf's taste lives.
export const tasteQueries = (repos, now = Date.now()) => {
  const pushed = `pushed:>${isoDaysBack(PUSHED_WITHIN_DAYS, now)}`;
  const queries = tasteTopics(repos).map((topic) => `topic:${topic} stars:>${SEARCH_STARS_TOPIC} ${pushed}`);
  const terms = tasteTerms(repos);
  if (terms.length >= 2) queries.push(`${terms.join(" ")} stars:>${SEARCH_STARS_TEXT} ${pushed}`);
  return queries;
};

// Score candidates against the shelf. Returns map-ready suggestion nodes with
// explained links (same edge shape as graph.js) to the own repos they match.
export const buildSuggestions = (ownRepos, candidates, { clusterOf = new Map(), limit = MAX_SUGGESTIONS } = {}) => {
  const ownIds = new Set(ownRepos.map((repo) => repo.id));
  const pool = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate?.id || ownIds.has(candidate.id) || candidate.archived || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    pool.push(candidate);
  }
  if (!ownRepos.length || !pool.length) return [];

  const ownProfiles = ownRepos.map(buildProfile);
  const poolProfiles = pool.map(buildProfile);
  const all = [...ownProfiles, ...poolProfiles];
  const topicIdf = idfMap(all.map((p) => p.topics));
  const termIdf = idfMap(all.map((p) => [...p.terms.keys()]));
  const norms = vectorNorms(all, termIdf);

  const scored = [];
  for (let c = 0; c < poolProfiles.length; c++) {
    const links = [];
    for (let o = 0; o < ownProfiles.length; o++) {
      const pair = pairScore(poolProfiles[c], ownProfiles[o], topicIdf, termIdf, norms);
      if (pair.score < MIN_LINK_SCORE) continue;
      // Substance required: shared topics/terms, or the maker of something on
      // the shelf — same language alone links half of GitHub.
      if (!pair.sharedTopics.length && !pair.sharedTerms.length && !pair.sameOwner) continue;
      links.push({
        source: ownRepos[o].id,
        target: pool[c].id,
        score: Number(pair.score.toFixed(3)),
        hidden: false,
        sharedTopics: pair.sharedTopics,
        sharedTerms: pair.sharedTerms,
        sameCategory: pair.sameCategory,
        sameOwner: pair.sameOwner,
        sameLanguage: pair.sameLanguage,
        weight: tasteWeight(ownRepos[o])
      });
    }
    if (!links.length) continue;
    links.sort((a, b) => b.score * b.weight - a.score * a.weight);
    const kept = links.slice(0, MAX_LINKS);
    // Best link counts full, the rest a third — breadth helps, but one strong
    // match to a "Bevalt" repo beats four weak ones. weight/3 makes keep = 1×.
    const score = kept.reduce((sum, link, i) => sum + link.score * (link.weight / 3) * (i === 0 ? 1 : 0.35), 0);
    scored.push({ candidate: pool[c], links: kept, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const perOwner = new Map();
  const result = [];
  for (const { candidate, links, score } of scored) {
    const owner = String(candidate.owner || "").toLowerCase();
    const taken = perOwner.get(owner) || 0;
    if (taken >= MAX_PER_OWNER) continue;
    perOwner.set(owner, taken + 1);
    result.push({
      ...candidate,
      suggested: true,
      score: Number(Math.min(1, score).toFixed(3)),
      cluster: clusterOf.get(links[0].source) ?? 0,
      links: links.map(({ weight, ...link }) => link)
    });
    if (result.length >= limit) break;
  }
  return result;
};
