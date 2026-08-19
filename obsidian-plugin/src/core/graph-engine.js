// The plugin bundles the app's own knowledge-graph engine (server/graph.js)
// so "Verwante repos" in the vault are computed by exactly the same code as
// the map inside the desktop app — no drift, and it works while the app is
// closed. esbuild inlines this at build time.
export { buildGraph } from "../../../server/graph.js";
