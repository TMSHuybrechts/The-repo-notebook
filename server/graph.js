// Knowledge-graph engine: links saved repos on shared topics, README/description
// similarity, language, category and owner — and explains every link so hidden
// connections become visible instead of a black-box score.

// Words that carry no signal: English + Dutch function words plus README
// boilerplate that nearly every repo shares (install, license, usage, ...).
const STOPWORDS = new Set(
  `a about above after again all also an and any are as at be because been
  before being below between both but by can could did do does doing down
  during each few for from further had has have having he her here hers him
  his how i if in into is it its itself just me more most my no nor not of
  off on once only or other our ours out over own same she should so some
  such than that the their theirs them then there these they this those
  through to too under until up very was we were what when where which while
  who whom why will with would you your yours
  de het een en van in op voor met als dat die dit je niet zijn aan bij ook
  naar dan nog wel geen om maar uit er wordt worden kan kunnen moet moeten
  installation install installing installed usage using use used getting
  started quick start guide documentation docs readme license mit apache
  contributing contribute contributions feature features support supported
  example examples run running build built version release releases new
  make making made need needs needed want file files folder directory set
  setup config configuration option options default available simple easy
  free open source project repo repository github git clone https http www
  com org api key token first like time just data based tool tools work
  works working add added adding create created creating provide provides
  requirements require required python javascript typescript node npm pip
  import status step steps follow following see more info information
  please note important warning windows linux macos download page web app
  application via etc code coding star stars fork issues pull request`
    .split(/\s+/)
    .filter(Boolean)
);

const tokenize = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9À-ɏ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && word.length <= 30 && !STOPWORDS.has(word) && !/^\d+$/.test(word));

const README_CHARS = 6000;
const DESCRIPTION_WEIGHT = 3;
const NAME_WEIGHT = 4;
const MAX_EDGES_PER_NODE = 6;
const MIN_EDGE_SCORE = 0.06;
// Below the threshold a node still keeps its single best neighbour (if any
// signal exists at all) so the map has no floating islands of one.
const FLOOR_EDGE_SCORE = 0.025;
const WEIGHT_TOPICS = 0.45;
const WEIGHT_TEXT = 0.45;
const BONUS_CATEGORY = 0.3;
const BONUS_OWNER = 0.25;
const BONUS_LANGUAGE = 0.05;

// Term profile per repo: name parts + description (weighted) + README excerpt.
const buildProfile = (repo) => {
  const terms = new Map();
  const bump = (word, weight) => terms.set(word, (terms.get(word) || 0) + weight);
  tokenize(repo.name.replace(/[-_.]/g, " ")).forEach((word) => bump(word, NAME_WEIGHT));
  tokenize(repo.description).forEach((word) => bump(word, DESCRIPTION_WEIGHT));
  tokenize((repo.readme || "").slice(0, README_CHARS)).forEach((word) => bump(word, 1));
  return {
    id: repo.id,
    topics: [...new Set((repo.topics || []).map((t) => t.toLowerCase()))],
    terms,
    language: (repo.language || "").toLowerCase(),
    category: (repo.category || "").trim().toLowerCase(),
    owner: repo.owner.toLowerCase()
  };
};

// Inverse document frequency: rare shared signals weigh more than "ai" or "llm"
// that half the shelf shares.
const idfMap = (documents) => {
  const df = new Map();
  for (const doc of documents) {
    for (const item of doc) df.set(item, (df.get(item) || 0) + 1);
  }
  const n = documents.length || 1;
  const idf = new Map();
  for (const [item, count] of df) idf.set(item, Math.log(1 + n / count));
  return idf;
};

// IDF-weighted cosine over topic sets (binary vectors): sharing one rare topic
// counts for more than sharing "ai" with half the shelf, and repos with long
// topic lists aren't punished as hard as plain Jaccard would.
const topicSimilarity = (a, b, idf) => {
  if (!a.topics.length || !b.topics.length) return { score: 0, shared: [] };
  const setB = new Set(b.topics);
  const shared = a.topics.filter((t) => setB.has(t));
  if (!shared.length) return { score: 0, shared: [] };
  const weight = (topic) => idf.get(topic) || 0;
  const dot = shared.reduce((sum, t) => sum + weight(t) ** 2, 0);
  const norm = (topics) => Math.sqrt(topics.reduce((sum, t) => sum + weight(t) ** 2, 0));
  const denominator = norm(a.topics) * norm(b.topics);
  return {
    score: denominator ? dot / denominator : 0,
    shared: [...shared].sort((x, y) => weight(y) - weight(x))
  };
};

// TF-IDF cosine over the term profiles, with the shared terms that drove it.
const textSimilarity = (a, b, idf, vectorNorm) => {
  const [small, large] = a.terms.size <= b.terms.size ? [a, b] : [b, a];
  let dot = 0;
  const contributions = [];
  for (const [word, tfSmall] of small.terms) {
    const tfLarge = large.terms.get(word);
    if (!tfLarge) continue;
    const weight = (idf.get(word) || 0) ** 2 * tfSmall * tfLarge;
    dot += weight;
    contributions.push([word, weight]);
  }
  if (!dot) return { score: 0, shared: [] };
  const norm = vectorNorm.get(a.id) * vectorNorm.get(b.id);
  return {
    score: norm ? dot / norm : 0,
    shared: contributions.sort((x, y) => y[1] - x[1]).slice(0, 5).map(([word]) => word)
  };
};

const pairScore = (a, b, topicIdf, termIdf, vectorNorm) => {
  const topics = topicSimilarity(a, b, topicIdf);
  const text = textSimilarity(a, b, termIdf, vectorNorm);
  const sameCategory = Boolean(a.category && a.category === b.category);
  const sameOwner = a.owner === b.owner;
  const sameLanguage = Boolean(a.language && a.language === b.language);
  const score =
    WEIGHT_TOPICS * topics.score +
    WEIGHT_TEXT * text.score +
    (sameCategory ? BONUS_CATEGORY : 0) +
    (sameOwner ? BONUS_OWNER : 0) +
    (sameLanguage ? BONUS_LANGUAGE : 0);
  return {
    score: Math.min(1, score),
    sharedTopics: topics.shared.slice(0, 6),
    sharedTerms: text.shared,
    sameCategory,
    sameOwner,
    sameLanguage,
    // A link is "hidden" when no explicit signal (topics/category/owner)
    // connects the repos — only their text does. Those are the finds.
    hidden: !topics.shared.length && !sameCategory && !sameOwner && text.score > 0
  };
};

// Weighted label propagation: every node adopts the dominant label among its
// neighbours until stable. Deterministic (sorted ids) so the map doesn't
// reshuffle on every refresh.
const detectClusters = (nodeIds, edges) => {
  const labels = new Map(nodeIds.map((id) => [id, id]));
  const neighbours = new Map(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    neighbours.get(edge.source)?.push({ id: edge.target, weight: edge.score });
    neighbours.get(edge.target)?.push({ id: edge.source, weight: edge.score });
  }
  const order = [...nodeIds].sort();
  for (let round = 0; round < 20; round++) {
    let changed = false;
    for (const id of order) {
      const tally = new Map();
      for (const { id: other, weight } of neighbours.get(id) || []) {
        const label = labels.get(other);
        tally.set(label, (tally.get(label) || 0) + weight);
      }
      if (!tally.size) continue;
      const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      if (best !== labels.get(id)) {
        labels.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return labels;
};

// Name a cluster after its most distinctive topics (fallback: TF-IDF terms).
const clusterLabel = (members, topicIdf, termIdf) => {
  const topicScore = new Map();
  for (const profile of members) {
    for (const topic of profile.topics) {
      topicScore.set(topic, (topicScore.get(topic) || 0) + (topicIdf.get(topic) || 0));
    }
  }
  const topTopics = [...topicScore.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([topic]) => topic);
  if (topTopics.length) return topTopics.join(" · ");

  const termScore = new Map();
  for (const profile of members) {
    for (const [word, tf] of profile.terms) {
      termScore.set(word, (termScore.get(word) || 0) + tf * (termIdf.get(word) || 0));
    }
  }
  return (
    [...termScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([word]) => word)
      .join(" · ") || "overig"
  );
};

export const buildGraph = (repos) => {
  const profiles = repos.map(buildProfile);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const topicIdf = idfMap(profiles.map((p) => p.topics));
  const termIdf = idfMap(profiles.map((p) => [...p.terms.keys()]));
  const vectorNorm = new Map(
    profiles.map((p) => {
      let sum = 0;
      for (const [word, tf] of p.terms) sum += ((termIdf.get(word) || 0) * tf) ** 2;
      return [p.id, Math.sqrt(sum)];
    })
  );

  // Score all pairs, then keep each node's strongest links so the map stays
  // readable instead of one hairball. A node whose best link falls below the
  // normal threshold still keeps that one link (floor) — no islands of one.
  const candidates = [];
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const pair = pairScore(profiles[i], profiles[j], topicIdf, termIdf, vectorNorm);
      if (pair.score >= FLOOR_EDGE_SCORE) {
        candidates.push({ source: profiles[i].id, target: profiles[j].id, ...pair });
      }
    }
  }
  const ranked = new Map(profiles.map((p) => [p.id, []]));
  for (const edge of candidates) {
    ranked.get(edge.source).push(edge);
    ranked.get(edge.target).push(edge);
  }
  const kept = new Set();
  for (const list of ranked.values()) {
    const sorted = list.sort((a, b) => b.score - a.score);
    sorted
      .filter((edge) => edge.score >= MIN_EDGE_SCORE)
      .slice(0, MAX_EDGES_PER_NODE)
      .forEach((edge) => kept.add(edge));
    if (sorted[0] && sorted[0].score < MIN_EDGE_SCORE) kept.add(sorted[0]);
  }
  const edges = candidates.filter((edge) => kept.has(edge));

  const labels = detectClusters(profiles.map((p) => p.id), edges);
  const clusterMembers = new Map();
  for (const [id, label] of labels) {
    clusterMembers.set(label, [...(clusterMembers.get(label) || []), byId.get(id)]);
  }
  const clusters = [...clusterMembers.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([label, members], index) => ({
      id: index,
      label: clusterLabel(members, topicIdf, termIdf),
      size: members.length,
      members: members.map((m) => m.id)
    }));
  const clusterOf = new Map();
  for (const cluster of clusters) {
    for (const id of cluster.members) clusterOf.set(id, cluster.id);
  }

  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes: repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.fullName,
      owner: repo.owner,
      description: repo.description || "",
      language: repo.language || "",
      category: repo.category || "",
      status: repo.status || "",
      stars: repo.stars || 0,
      topics: (repo.topics || []).slice(0, 8),
      cluster: clusterOf.get(repo.id) ?? 0,
      degree: degree.get(repo.id) || 0
    })),
    edges: edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      score: Number(edge.score.toFixed(3)),
      hidden: edge.hidden,
      sharedTopics: edge.sharedTopics,
      sharedTerms: edge.sharedTerms,
      sameCategory: edge.sameCategory,
      sameOwner: edge.sameOwner,
      sameLanguage: edge.sameLanguage
    })),
    clusters: clusters.map(({ members, ...cluster }) => cluster)
  };
};
