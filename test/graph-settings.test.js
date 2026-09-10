import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, clusterColor, clusterKeys, nodeColor, nodeRadius, normalizeSettings, visibleGraph } from '../src/graph-settings.js';

const graph = Object.freeze({
  nodes: Object.freeze([
    Object.freeze({ id: 'a', cluster: 0, status: 'todo', stars: 0, degree: 2 }),
    Object.freeze({ id: 'b', cluster: 0, status: 'installed', stars: 500, degree: 1 }),
    Object.freeze({ id: 'c', cluster: 1, status: '', stars: 1000000, degree: 1 })
  ]),
  edges: Object.freeze([
    Object.freeze({ source: 'a', target: 'b' }),
    Object.freeze({ source: 'a', target: 'c' })
  ])
});

test('cluster toggles remove incident links, restore originals and never mutate source', () => {
  const before = JSON.stringify(graph);
  for (let i = 0; i < 50; i++) {
    const visible = visibleGraph(graph, new Set([1]));
    assert.deepEqual(visible.nodes.map(n => n.id), ['a', 'b']);
    assert.deepEqual(visible.edges, [graph.edges[0]]);
    assert.equal(visibleGraph(graph, new Set([0])).edges.length, 0);
    assert.equal(visibleGraph(graph, new Set([0, 1])).nodes.length, 0);
    assert.deepEqual(visibleGraph(graph, new Set()).edges, graph.edges);
  }
  assert.equal(JSON.stringify(graph), before);
  assert.deepEqual(visibleGraph(null, new Set()).nodes, []);
  assert.equal(visibleGraph({ ...graph, edges: [...graph.edges, { source: 'a', target: 'missing' }] }, new Set()).edges.length, 2);
});

test('size modes stay finite and bounded for missing, negative and extreme metrics', () => {
  for (const value of [undefined, -100, 0, 1, 500, 1e300, Infinity, NaN]) {
    for (const mode of ['fixed', 'stars', 'degree']) {
      const radius = nodeRadius({ stars: value, degree: value }, mode);
      assert.ok(Number.isFinite(radius) && radius >= 6 && radius <= 15);
    }
  }
  assert.equal(nodeRadius(graph.nodes[0], 'fixed'), nodeRadius(graph.nodes[2], 'fixed'));
  assert.ok(nodeRadius(graph.nodes[2], 'stars') > nodeRadius(graph.nodes[0], 'stars'));
  assert.ok(nodeRadius(graph.nodes[0], 'degree') > nodeRadius(graph.nodes[1], 'degree'));
});

test('all colour modes resolve correctly; manual colours follow membership, not renumbering', () => {
  const keys = clusterKeys(graph);
  assert.equal(nodeColor(graph.nodes[0], DEFAULT_SETTINGS, keys), clusterColor(0));
  const mono = { ...DEFAULT_SETTINGS, colorMode: 'mono', monoColor: '#123456' };
  assert.ok(graph.nodes.every(n => nodeColor(n, mono, keys) === '#123456'));
  const status = { ...DEFAULT_SETTINGS, colorMode: 'status' };
  assert.equal(nodeColor(graph.nodes[0], status, keys), status.todoColor);
  assert.equal(nodeColor(graph.nodes[1], status, keys), status.otherColor);
  assert.equal(nodeColor(graph.nodes[2], status, keys), status.otherColor);
  const manual = { ...DEFAULT_SETTINGS, colorMode: 'manual', clusterColors: { [keys.get(0)]: '#abcdef' } };
  const reordered = { nodes: graph.nodes.map(n => ({ ...n, cluster: n.cluster + 10 })).reverse() };
  assert.equal(nodeColor(reordered.nodes[2], manual, clusterKeys(reordered)), '#abcdef');
  assert.equal(nodeColor(graph.nodes[2], manual, keys), clusterColor(1));
});

test('persisted settings roundtrip and invalid values safely return to defaults', () => {
  const settings = { ...DEFAULT_SETTINGS, springK: 0.08, repulsion: 4000, sizeMode: 'stars', colorMode: 'manual', clusterColors: { group: '#abcdef' } };
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(settings))), settings);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  const safe = normalizeSettings({ springK: Infinity, repulsion: -10, sizeMode: 'huge', colorMode: 'bad', monoColor: 'red', clusterColors: { a: 'invalid' } });
  assert.equal(safe.springK, DEFAULT_SETTINGS.springK);
  assert.equal(safe.repulsion, 0);
  assert.equal(safe.sizeMode, 'degree');
  assert.equal(safe.colorMode, 'cluster');
  assert.deepEqual(safe.clusterColors, {});
});
