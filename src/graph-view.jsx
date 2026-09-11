import React, { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, EyeOff, List, Loader2, Maximize2, Network, Star, X } from "lucide-react";
import { shortNumber } from "./format";

import { clusterColor, clusterKeys, DEFAULT_SETTINGS, loadGraphSettings, nodeColor, nodeRadius, SETTINGS_KEY, visibleGraph } from "./graph-settings.js";
export { clusterColor } from "./graph-settings.js";

// Human-readable "why are these linked" chips for an edge.
export const edgeReasons = (edge) => {
  const reasons = [];
  if (edge.sharedTopics?.length) reasons.push({ kind: "topics", label: edge.sharedTopics.slice(0, 3).join(" · ") });
  if (edge.sameCategory) reasons.push({ kind: "flag", label: "zelfde categorie" });
  if (edge.sameOwner) reasons.push({ kind: "flag", label: "zelfde maker" });
  if (edge.sharedTerms?.length) reasons.push({ kind: "text", label: `tekst: ${edge.sharedTerms.slice(0, 3).join(", ")}` });
  if (edge.sameLanguage && !edge.sharedTopics?.length) reasons.push({ kind: "flag", label: "zelfde taal" });
  return reasons;
};

const edgesFor = (graph, repoId) =>
  (graph?.edges || [])
    .filter((edge) => edge.source === repoId || edge.target === repoId)
    .map((edge) => ({ ...edge, otherId: edge.source === repoId ? edge.target : edge.source }))
    .sort((a, b) => b.score - a.score);

// Rows of related repos with reason chips — shared by the map info card and
// the list-view "Verwant" panel.
function RelatedRows({ graph, repoId, onSelect, limit = 6, colorFor = (node) => clusterColor(node.cluster) }) {
  const nodes = useMemo(() => new Map((graph?.nodes || []).map((node) => [node.id, node])), [graph]);
  const related = useMemo(() => edgesFor(graph, repoId).slice(0, limit), [graph, repoId, limit]);

  if (!related.length) return <p className="muted">Nog geen verwante repos gevonden.</p>;
  return (
    <div className="related-rows">
      {related.map((edge) => {
        const other = nodes.get(edge.otherId);
        if (!other) return null;
        return (
          <button className="related-row" key={edge.otherId} onClick={() => onSelect(other.id)} type="button">
            <span className="related-title">
              <i style={{ background: colorFor(other) }} />
              <strong>{other.name}</strong>
              <small>{other.owner}</small>
              {edge.hidden && <span className="hidden-badge">verborgen link</span>}
              <span className="related-score">{Math.round(edge.score * 100)}%</span>
            </span>
            <span className="related-reasons">
              {edgeReasons(edge).map((reason, index) => (
                <span className={`reason ${reason.kind}`} key={index}>{reason.label}</span>
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// "Verwant" panel for the list detail view.
export function RelatedPanel({ graph, repo, onSelect }) {
  if (!graph || !repo) return null;
  return (
    <section className="panel related">
      <div className="panel-head">
        <h2><Network size={16} /> Verwante repos</h2>
      </div>
      <RelatedRows graph={graph} onSelect={onSelect} repoId={repo.id} />
    </section>
  );
}

// --- Force-directed map -----------------------------------------------------

const SIM = {
  clusterPull: 0.015,
  centerPull: 0.004,
  damping: 0.85,
  minAlpha: 0.015
};

const restLength = (score) => 70 + (1 - score) * 100;

export function GraphView({ graph, loading, onOpenRepo }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const simRef = useRef({ nodes: [], byId: new Map(), anchors: new Map(), alpha: 1 });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const pointerRef = useRef({ mode: "", node: null, sx: 0, sy: 0, moved: 0 });
  const hoverRef = useRef("");
  const [selectedId, setSelectedId] = useState("");
  const [focusCluster, setFocusCluster] = useState(null);
  const [onlyHidden, setOnlyHidden] = useState(false);
  const [settings, setSettings] = useState(loadGraphSettings);
  const [hiddenClusters, setHiddenClusters] = useState(() => new Set());
  const visible = useMemo(() => visibleGraph(graph, hiddenClusters), [graph, hiddenClusters]);
  const visibleIds = useMemo(() => new Set(visible.nodes.map((node) => node.id)), [visible]);
  const keys = useMemo(() => clusterKeys(graph), [graph]);
  const colorFor = (node) => nodeColor(node, settings, keys);
  const stateRef = useRef(null);
  stateRef.current = { selectedId, focusCluster, onlyHidden, graph: visible, visibleIds, settings, keys };

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
    catch { /* Settings still work in memory when storage is unavailable. */ }
  }, [settings]);

  useEffect(() => {
    simRef.current.alpha = Math.max(simRef.current.alpha, 0.5);
  }, [settings.springK, settings.repulsion, visible]);

  useEffect(() => {
    if (!visibleIds.has(hoverRef.current)) hoverRef.current = "";
    if (pointerRef.current.node && !visibleIds.has(pointerRef.current.node.id)) {
      pointerRef.current = { mode: "", node: null, sx: 0, sy: 0, moved: 0 };
    }
  }, [visibleIds]);

  const updateSetting = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const toggleCluster = (id) => setHiddenClusters((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const neighbours = useMemo(() => {
    const map = new Map();
    for (const edge of visible.edges) {
      map.set(edge.source, (map.get(edge.source) || new Set()).add(edge.target));
      map.set(edge.target, (map.get(edge.target) || new Set()).add(edge.source));
    }
    return map;
  }, [visible]);
  const neighboursRef = useRef(neighbours);
  neighboursRef.current = neighbours;

  // (Re)seed the simulation whenever the graph changes: clusters start on a
  // ring so the groups are visible from the first frame.
  useEffect(() => {
    if (!graph?.nodes?.length) {
      simRef.current = { nodes: [], byId: new Map(), anchors: new Map(), alpha: 0 };
      return;
    }
    const wrap = wrapRef.current;
    const width = wrap?.clientWidth || 1200;
    const height = wrap?.clientHeight || 700;
    const cx = width / 2;
    const cy = height / 2;
    const ring = Math.min(width, height) * 0.31;
    const anchors = new Map();
    const clusterCount = Math.max(1, graph.clusters.length);
    graph.clusters.forEach((cluster, index) => {
      const angle = (index / clusterCount) * Math.PI * 2 - Math.PI / 2;
      const spread = cluster.size > 4 ? 1 : 1.25;
      anchors.set(cluster.id, { x: cx + Math.cos(angle) * ring * spread, y: cy + Math.sin(angle) * ring * spread });
    });
    const previous = simRef.current.byId;
    const nodes = graph.nodes.map((node) => {
      const anchor = anchors.get(node.cluster) || { x: cx, y: cy };
      const old = previous.get(node.id);
      return {
        ...node,
        x: old?.x ?? anchor.x + (Math.random() - 0.5) * 130,
        y: old?.y ?? anchor.y + (Math.random() - 0.5) * 130,
        vx: 0,
        vy: 0
      };
    });
    simRef.current = { nodes, byId: new Map(nodes.map((n) => [n.id, n])), anchors, alpha: 1, cx, cy };
    viewRef.current = { x: 0, y: 0, k: 1 };
  }, [graph]);

  // Physics + paint loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;
    const ctx = canvas.getContext("2d");
    let raf = 0;

    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wrap.clientWidth * dpr;
      canvas.height = wrap.clientHeight * dpr;
      canvas.style.width = `${wrap.clientWidth}px`;
      canvas.style.height = `${wrap.clientHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(wrap);

    const step = () => {
      const sim = simRef.current;
      const { graph: g, visibleIds: ids, settings: options } = stateRef.current;
      if (sim.alpha > SIM.minAlpha && sim.nodes.length) {
        const { byId, anchors, alpha } = sim;
        const nodes = sim.nodes.filter((node) => ids.has(node.id));
        for (const edge of g?.edges || []) {
          const a = byId.get(edge.source);
          const b = byId.get(edge.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          const force = (dist - restLength(edge.score)) * options.springK * (0.4 + edge.score) * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d2 = Math.max(90, dx * dx + dy * dy);
            const force = (options.repulsion / d2) * alpha;
            const dist = Math.sqrt(d2);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx; a.vy -= fy;
            b.vx += fx; b.vy += fy;
          }
        }
        for (const node of nodes) {
          const anchor = anchors.get(node.cluster);
          if (anchor) {
            node.vx += (anchor.x - node.x) * SIM.clusterPull * alpha;
            node.vy += (anchor.y - node.y) * SIM.clusterPull * alpha;
          }
          node.vx += (sim.cx - node.x) * SIM.centerPull * alpha;
          node.vy += (sim.cy - node.y) * SIM.centerPull * alpha;
          if (node !== pointerRef.current.node) {
            node.vx *= SIM.damping;
            node.vy *= SIM.damping;
            node.x += node.vx;
            node.y += node.vy;
          }
        }
        sim.alpha *= 0.994;
      }
      paint(ctx, canvas);
      raf = requestAnimationFrame(step);
    };

    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const view = viewRef.current;
      const sim = simRef.current;
      const { graph: g, selectedId, focusCluster, onlyHidden: hiddenOnly, visibleIds: ids, settings: options, keys: colorKeys } = stateRef.current;
      const selected = ids.has(selectedId) ? selectedId : "";
      const focus = g.nodes.some((node) => node.cluster === focusCluster) ? focusCluster : null;
      const nodes = sim.nodes.filter((node) => ids.has(node.id));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
      if (!g) return;

      const hover = hoverRef.current;
      const near = hover ? neighboursRef.current.get(hover) : selected ? neighboursRef.current.get(selected) : null;
      const anchorId = hover || selected;
      const nodeAlpha = (node) => {
        if (focus !== null && node.cluster !== focus) return 0.08;
        if (hiddenOnly && !node.onHidden) return 0.12;
        if (anchorId && node.id !== anchorId && !(near?.has(node.id))) return 0.16;
        return 1;
      };

      for (const node of nodes) node.onHidden = false;
      if (hiddenOnly) {
        for (const edge of g.edges) {
          if (!edge.hidden) continue;
          const a = sim.byId.get(edge.source);
          const b = sim.byId.get(edge.target);
          if (a) a.onHidden = true;
          if (b) b.onHidden = true;
        }
      }

      for (const edge of g.edges) {
        if (hiddenOnly && !edge.hidden) continue;
        const a = sim.byId.get(edge.source);
        const b = sim.byId.get(edge.target);
        if (!a || !b) continue;
        let alpha = 0.14 + edge.score * 0.5;
        if (focus !== null && (a.cluster !== focus || b.cluster !== focus)) alpha = 0.03;
        if (anchorId) alpha = edge.source === anchorId || edge.target === anchorId ? 0.75 : 0.04;
        ctx.strokeStyle = edge.hidden ? `rgba(242, 204, 96, ${alpha})` : `rgba(151, 166, 184, ${alpha})`;
        ctx.lineWidth = (0.6 + edge.score * 2.4) / view.k;
        ctx.setLineDash(edge.hidden ? [5 / view.k, 4 / view.k] : []);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const fontPx = Math.max(10, 11 / view.k);
      ctx.textAlign = "center";
      for (const node of nodes) {
        const alpha = nodeAlpha(node);
        const radius = nodeRadius(node, options.sizeMode);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = nodeColor(node, options, colorKeys);
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fill();
        if (node.id === selected || node.id === hover) {
          ctx.strokeStyle = "#f1f6ff";
          ctx.lineWidth = 2 / view.k;
          ctx.stroke();
        }
        const showLabel =
          view.k >= 1.35 || node.id === hover || node.id === selected || near?.has(node.id) || node.degree >= 5;
        if (showLabel && alpha > 0.2) {
          ctx.font = `${fontPx}px Inter, sans-serif`;
          ctx.fillStyle = "rgba(241, 246, 255, 0.92)";
          ctx.fillText(node.name, node.x, node.y - radius - 5 / view.k);
        }
        ctx.globalAlpha = 1;
      }
    };

    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  // --- pointer interaction ---
  const toWorld = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const view = viewRef.current;
    return { x: (event.clientX - rect.left - view.x) / view.k, y: (event.clientY - rect.top - view.y) / view.k };
  };
  const hitNode = (point) =>
    simRef.current.nodes.findLast((node) => visibleIds.has(node.id) && Math.hypot(node.x - point.x, node.y - point.y) <= nodeRadius(node, settings.sizeMode) + 4);

  const onPointerDown = (event) => {
    const point = toWorld(event);
    const node = hitNode(point);
    pointerRef.current = { mode: node ? "drag" : "pan", node, sx: event.clientX, sy: event.clientY, moved: 0 };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
  };
  const onPointerMove = (event) => {
    const pointer = pointerRef.current;
    if (pointer.mode === "drag" && pointer.node) {
      const point = toWorld(event);
      pointer.node.x = point.x;
      pointer.node.y = point.y;
      pointer.node.vx = 0;
      pointer.node.vy = 0;
      pointer.moved += 1;
      simRef.current.alpha = Math.max(simRef.current.alpha, 0.25);
    } else if (pointer.mode === "pan") {
      viewRef.current.x += event.clientX - pointer.sx;
      viewRef.current.y += event.clientY - pointer.sy;
      pointer.sx = event.clientX;
      pointer.sy = event.clientY;
      pointer.moved += 1;
    } else {
      const node = hitNode(toWorld(event));
      hoverRef.current = node?.id || "";
      canvasRef.current.style.cursor = node ? "pointer" : "grab";
    }
  };
  const onPointerUp = (event) => {
    const pointer = pointerRef.current;
    if (pointer.mode === "drag" && pointer.node && pointer.moved < 3) {
      setSelectedId((current) => (current === pointer.node.id ? "" : pointer.node.id));
    }
    pointerRef.current = { mode: "", node: null, sx: 0, sy: 0, moved: 0 };
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* no capture to release */
    }
  };
  const onDoubleClick = (event) => {
    const node = hitNode(toWorld(event));
    if (node) onOpenRepo(node.id);
  };
  const onWheel = (event) => {
    const view = viewRef.current;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.14 : 1 / 1.14;
    const next = Math.min(3.2, Math.max(0.3, view.k * factor));
    view.x = mx - ((mx - view.x) / view.k) * next;
    view.y = my - ((my - view.y) / view.k) * next;
    view.k = next;
  };
  const resetView = () => {
    viewRef.current = { x: 0, y: 0, k: 1 };
    simRef.current.alpha = Math.max(simRef.current.alpha, 0.2);
  };

  const selectedNode = visible.nodes.find((node) => node.id === selectedId);
  const hiddenCount = visible.edges.filter((edge) => edge.hidden).length || 0;

  return (
    <div className="graph-view" ref={wrapRef}>
      <canvas
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { pointerRef.current = { mode: "", node: null, sx: 0, sy: 0, moved: 0 }; }}
        onPointerLeave={() => { hoverRef.current = ""; }}
        aria-label="Interactieve repositorykaart"
        onWheel={onWheel}
        ref={canvasRef}
      />
      {loading && (
        <div className="graph-loading"><Loader2 className="spin" size={22} /> Kaart berekenen...</div>
      )}
      {graph && (
        <aside className="graph-legend">
          <h3><Network size={15} /> Clusters</h3>
          <p className="graph-count" aria-live="polite">{visible.nodes.length} / {graph.nodes.length} repos · {visible.edges.length} links</p>
          {graph.clusters.map((cluster) => (
            <div className="graph-cluster-row" key={cluster.id}>
              <input type="checkbox" checked={!hiddenClusters.has(cluster.id)}
                aria-label={`Toon cluster ${cluster.label}`}
                onChange={() => toggleCluster(cluster.id)} />
              <button
                className={focusCluster === cluster.id ? "active" : ""}
                disabled={hiddenClusters.has(cluster.id)}
                aria-pressed={focusCluster === cluster.id}
                title="Cluster uitlichten"
                onClick={() => setFocusCluster((current) => current === cluster.id ? null : cluster.id)}
                type="button"
              >
                <i style={{ background: settings.colorMode === "status" ? `linear-gradient(90deg, ${settings.todoColor} 50%, ${settings.otherColor} 50%)` : colorFor({ cluster: cluster.id }) }} />
                <span>{cluster.label}</span><small>{cluster.size}</small>
              </button>
            </div>
          ))}
          {!!hiddenClusters.size && <button type="button" onClick={() => setHiddenClusters(new Set())}>Alle clusters tonen</button>}
          <details className="graph-settings">
            <summary>Kaartinstellingen</summary>
            <label>Aantrekking <output>{settings.springK.toFixed(3)}</output>
              <input aria-label="Aantrekking" type="range" min="0" max="0.1" step="0.005" value={settings.springK}
                onChange={(event) => updateSetting("springK", Number(event.target.value))} />
            </label>
            <label>Afstoting <output>{settings.repulsion}</output>
              <input aria-label="Afstoting" type="range" min="0" max="6000" step="100" value={settings.repulsion}
                onChange={(event) => updateSetting("repulsion", Number(event.target.value))} />
            </label>
            <button type="button" onClick={() => setSettings((current) => ({ ...current, springK: DEFAULT_SETTINGS.springK, repulsion: DEFAULT_SETTINGS.repulsion }))}>Reset physics</button>
            <label>Bolletjesgrootte
              <select aria-label="Bolletjesgrootte" value={settings.sizeMode} onChange={(event) => updateSetting("sizeMode", event.target.value)}>
                <option value="fixed">Vast</option><option value="stars">Stars</option><option value="degree">Aantal links</option>
              </select>
            </label>
            <label>Kleurmodus
              <select aria-label="Kleurmodus" value={settings.colorMode} onChange={(event) => updateSetting("colorMode", event.target.value)}>
                <option value="mono">Mono</option><option value="status">2 kleuren (status)</option>
                <option value="cluster">Per cluster</option><option value="manual">Handmatig per cluster</option>
              </select>
            </label>
            {settings.colorMode === "mono" && <label className="graph-color">Alle nodes
              <input type="color" value={settings.monoColor} onChange={(event) => updateSetting("monoColor", event.target.value)} />
            </label>}
            {settings.colorMode === "status" && <>
              <label className="graph-color">Te proberen<input type="color" value={settings.todoColor} onChange={(event) => updateSetting("todoColor", event.target.value)} /></label>
              <label className="graph-color">Overige statussen<input type="color" value={settings.otherColor} onChange={(event) => updateSetting("otherColor", event.target.value)} /></label>
            </>}
            {settings.colorMode === "manual" && graph.clusters.map((cluster) => (
              <label className="graph-color" key={cluster.id}>{cluster.label}
                <input type="color" aria-label={`Kleur ${cluster.label}`} value={colorFor({ cluster: cluster.id })}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSettings((current) => ({ ...current, clusterColors: { ...current.clusterColors, [keys.get(cluster.id)]: value } }));
                  }} />
              </label>
            ))}
            <button type="button" onClick={() => setSettings((current) => ({ ...current, colorMode: DEFAULT_SETTINGS.colorMode, monoColor: DEFAULT_SETTINGS.monoColor, todoColor: DEFAULT_SETTINGS.todoColor, otherColor: DEFAULT_SETTINGS.otherColor, clusterColors: {} }))}>Reset kleuren</button>
            <p className="legend-hint">Grootte blijft begrensd. Instellingen worden op dit apparaat bewaard.</p>
          </details>
          <div className="legend-actions">
            <button className={onlyHidden ? "active" : ""} onClick={() => setOnlyHidden((v) => !v)} type="button">
              <EyeOff size={13} /> Verborgen links ({hiddenCount})
            </button>
            <button onClick={resetView} title="Zoom terugzetten" type="button"><Maximize2 size={13} /></button>
          </div>
          <p className="legend-hint">Vinkje = tonen/verbergen · clusternaam = uitlichten · klik node = selecteer · dubbelklik = open · sleep = verplaats</p>
        </aside>
      )}
      {selectedNode && (
        <aside className="graph-card">
          <div className="graph-card-head">
            <i style={{ background: colorFor(selectedNode) }} />
            <strong>{selectedNode.name}</strong>
            <button className="icon" onClick={() => setSelectedId("")} type="button"><X size={15} /></button>
          </div>
          <small className="graph-card-owner">{selectedNode.owner} · <Star size={12} /> {shortNumber(selectedNode.stars)}{selectedNode.language ? ` · ${selectedNode.language}` : ""}</small>
          {selectedNode.description && <p>{selectedNode.description}</p>}
          {!!selectedNode.topics?.length && (
            <div className="topics">{selectedNode.topics.slice(0, 6).map((topic) => <span key={topic}>{topic}</span>)}</div>
          )}
          <div className="graph-card-actions">
            <button className="primary" onClick={() => onOpenRepo(selectedNode.id)} type="button"><List size={14} /> Open in lijst</button>
            <a href={`https://github.com/${selectedNode.fullName}`} rel="noreferrer" target="_blank"><ExternalLink size={14} /> GitHub</a>
          </div>
          <h4>Gelinkt met</h4>
          <RelatedRows colorFor={colorFor} graph={visible} limit={8} onSelect={setSelectedId} repoId={selectedNode.id} />
        </aside>
      )}
    </div>
  );
}
