import test from "node:test";
import assert from "node:assert/strict";
import { searchSavedRepos } from "../mcp/server.js";

const shelf = [
  { fullName: "espressif/esp-idf", description: "Espressif IoT Development Framework", language: "C", stars: 15000, topics: ["esp32"], status: "keep" },
  { fullName: "lvgl/lvgl", description: "Embedded graphics library", language: "C", stars: 18000, topics: ["display", "esp32"], category: "Hardware" },
  { fullName: "n8n-io/n8n", description: "Workflow automation", language: "TypeScript", stars: 200000, topics: ["automation"], status: "todo", note: "voor lead-opvolging" },
  { fullName: "ollama/ollama", description: "Run large language models locally", language: "Go", stars: 150000, topics: ["llm"], category: "AI" }
];

const names = (result) => result.repos.map((r) => r.fullName);

test("every query word must match somewhere in the saved repo", () => {
  assert.deepEqual(names(searchSavedRepos(shelf, { query: "esp32" })), ["lvgl/lvgl", "espressif/esp-idf"]);
  assert.deepEqual(names(searchSavedRepos(shelf, { query: "esp32 display" })), ["lvgl/lvgl"]);
  assert.equal(searchSavedRepos(shelf, { query: "esp32 kubernetes" }).total, 0);
});

test("matches notes and is case-insensitive", () => {
  assert.deepEqual(names(searchSavedRepos(shelf, { query: "LEAD" })), ["n8n-io/n8n"]);
});

test("filters by language, status and category", () => {
  assert.deepEqual(names(searchSavedRepos(shelf, { language: "c" })), ["lvgl/lvgl", "espressif/esp-idf"]);
  assert.deepEqual(names(searchSavedRepos(shelf, { status: "todo" })), ["n8n-io/n8n"]);
  assert.deepEqual(names(searchSavedRepos(shelf, { category: "hard" })), ["lvgl/lvgl"]);
  assert.deepEqual(names(searchSavedRepos(shelf, { query: "esp32", status: "keep" })), ["espressif/esp-idf"]);
});

test("sorts by stars, caps the result and reports the full total", () => {
  const result = searchSavedRepos(shelf, { limit: 2 });
  assert.equal(result.total, 4);
  assert.deepEqual(names(result), ["n8n-io/n8n", "ollama/ollama"]);
  assert.equal(searchSavedRepos(shelf, { limit: 999 }).repos.length, 4);
});

test("does not change the saved shelf", () => {
  const before = JSON.stringify(shelf);
  searchSavedRepos(shelf, { query: "esp32", limit: 1 });
  assert.equal(JSON.stringify(shelf), before);
});
