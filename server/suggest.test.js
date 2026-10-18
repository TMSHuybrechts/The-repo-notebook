// node --test server/ — pure-logic tests for the personal-suggestions engine.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSuggestions, tasteQueries, tasteTopics, tasteWeight } from "./suggest.js";

const shelf = (id, extra = {}) => {
  const [owner, name] = id.split("/");
  return { id, owner, name, fullName: id, description: "", topics: [], ...extra };
};

test("tasteWeight: Bevalt weegt zwaarder dan todo, klonen telt mee", () => {
  assert.ok(tasteWeight(shelf("a/keep", { status: "keep" })) > tasteWeight(shelf("a/todo", { status: "todo" })));
  assert.ok(tasteWeight(shelf("a/arch", { status: "archive" })) < tasteWeight(shelf("a/none")));
  assert.ok(tasteWeight(shelf("a/cloned", { localPath: "D:\\x" })) > tasteWeight(shelf("a/plain")));
});

test("tasteTopics: status-gewicht duwt keep-topics boven archief-topics", () => {
  const repos = [
    shelf("a/one", { status: "keep", topics: ["speech", "ml"] }),
    shelf("a/two", { status: "keep", topics: ["speech"] }),
    shelf("a/three", { status: "archive", topics: ["crypto", "ml"] }),
    shelf("a/four", { status: "archive", topics: ["crypto"] })
  ];
  const topics = tasteTopics(repos, 4);
  assert.ok(topics.indexOf("speech") < topics.indexOf("crypto"), `speech voor crypto in ${topics}`);
});

test("tasteQueries: topic-queries met sterren- en pushed-filter, max 5", () => {
  const repos = [
    shelf("a/one", { status: "keep", topics: ["speech", "whisper"], description: "voice transcription tool" }),
    shelf("a/two", { topics: ["speech"], description: "speech to text engine" }),
    shelf("b/three", { topics: ["whisper"], description: "whisper voice model runner" })
  ];
  const queries = tasteQueries(repos, Date.parse("2026-08-21T00:00:00Z"));
  assert.ok(queries.length >= 1 && queries.length <= 5, `1-5 queries, kreeg ${queries.length}`);
  assert.ok(queries.some((q) => q.startsWith("topic:")), "minstens één topic-query");
  for (const q of queries) {
    assert.match(q, /stars:>\d+/);
    assert.match(q, /pushed:>2025-11-2\d/);
  }
});

const own = [
  shelf("me/voice-keep", {
    status: "keep",
    topics: ["speech", "whisper"],
    description: "local speech transcription with whisper models",
    category: "AI"
  }),
  shelf("me/voice-todo", {
    status: "todo",
    topics: ["speech"],
    description: "speech synthesis playground for voice cloning experiments"
  }),
  shelf("me/game-archive", {
    status: "archive",
    topics: ["gamedev", "engine"],
    description: "abandoned game engine prototype with shaders"
  })
];

const candidate = (id, extra = {}) => {
  const [owner, name] = id.split("/");
  return { id, owner, name, fullName: id, description: "", topics: [], stars: 100, htmlUrl: `https://github.com/${id}`, ...extra };
};

test("buildSuggestions: sluit eigen, gearchiveerde en dubbele kandidaten uit", () => {
  const result = buildSuggestions(own, [
    candidate("me/voice-keep", { topics: ["speech"] }),
    candidate("x/dead", { topics: ["speech", "whisper"], archived: true }),
    candidate("x/live", { topics: ["speech", "whisper"], description: "fast whisper transcription server" }),
    candidate("x/live", { topics: ["speech", "whisper"], description: "fast whisper transcription server" })
  ]);
  assert.deepEqual(result.map((s) => s.id), ["x/live"]);
});

test("buildSuggestions: match met keep-repo scoort boven match met archief-repo", () => {
  const result = buildSuggestions(own, [
    candidate("x/talker", { topics: ["speech", "whisper"], description: "realtime whisper speech transcription" }),
    candidate("y/shooter", { topics: ["gamedev", "engine"], description: "game engine with shaders prototype" })
  ]);
  assert.equal(result[0].id, "x/talker");
  assert.ok(result[0].score > (result.find((s) => s.id === "y/shooter")?.score ?? 0));
});

test("buildSuggestions: links wijzen naar eigen repos, met gedeelde topics en clusternummer", () => {
  const clusterOf = new Map([["me/voice-keep", 7]]);
  const [hit] = buildSuggestions(own, [
    candidate("x/talker", { topics: ["speech", "whisper"], description: "realtime whisper speech transcription" })
  ], { clusterOf });
  assert.ok(hit.suggested);
  assert.equal(hit.cluster, 7);
  assert.ok(hit.links.length >= 1);
  for (const link of hit.links) {
    assert.ok(own.some((r) => r.id === link.source), `bron ${link.source} is een eigen repo`);
    assert.equal(link.target, "x/talker");
    assert.equal(link.weight, undefined, "intern gewicht lekt niet naar buiten");
  }
  assert.ok(hit.links[0].sharedTopics.includes("speech") || hit.links[0].sharedTopics.includes("whisper"));
});

test("buildSuggestions: enkel-zelfde-taal is geen reden, en max 2 per maker", () => {
  const none = buildSuggestions(own, [
    candidate("x/random", { language: "Python", description: "totally unrelated quantum farming toolkit" })
  ]);
  assert.equal(none.length, 0, "geen gedeelde topics/termen → geen suggestie");

  const flood = buildSuggestions(own, ["a", "b", "c", "d"].map((n) =>
    candidate(`samefactory/${n}`, { topics: ["speech", "whisper"], description: "whisper speech transcription toolkit" })
  ));
  assert.ok(flood.length <= 2, `max 2 van dezelfde maker, kreeg ${flood.length}`);
});
