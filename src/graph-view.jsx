import React, { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, EyeOff, List, Loader2, Maximize2, Network, Star, X } from "lucide-react";
import { shortNumber } from "./format";

// One colour per cluster — the "mappen" of the map.
const CLUSTER_COLORS = [
  "#2f81f7", "#4fd1a5", "#f0883e", "#d2a8ff", "#f2cc60", "#ff7b72",
  "#79c0ff", "#56d364", "#e3b341", "#ffa198", "#a5d6ff", "#7ee787"
];
export const clusterColor = (index) => CLUSTER_COLORS[index % CLUSTER_COLORS.length];

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
function RelatedRows({ graph, repoId, onSelect, limit = 6 }) {
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
              <i style={{ background: clusterColor(other.cluster) }} />
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
  springK: 0.035,
  repulsion: 1500,
  clusterPull: 0.015,
  centerPull: 0.004,
  damping: 0.85,
  minAlpha: 0.015
};

const restLength = (score) => 70 + (1 - score) * 100;
const nodeRadius = (node) => 6 + Math.min(9, Math.sqrt(node.degree || 0) * 2.2);

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
  const stateRef = useRef({ selectedId, focusCluster, onlyHidden, graph });
  stateRef.current = { selectedId, focusCluster, onlyHidden, graph };

  const neighbours = useMemo(() => {
    const map = new Map();
    for (const edge of graph?.edges || []) {
      map.set(edge.source, (map.get(edge.source) || new Set()).add(edge.target));
      map.set(edge.target, (map.get(edge.target) || new Set()).add(edge.source));
    }
    return map;
  }, [graph]);
  const neighboursRef = useRef(neighbours);
  neighboursRef.current = neighbours;

  // (Re)seed the simulation whenever the graph changes: clusters start on a
  // ring so the groups are visible from the first frame.
  useEffect(() => {
    if (!graph?.nodes?.length) return;
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
      const { graph: g } = stateRef.current;
      if (sim.alpha > SIM.minAlpha && sim.nodes.length) {
        const { nodes, byId, anchors, alpha } = sim;
        for (const edge of g?.edges || []) {
          const a = byId.get(edge.source);
          const b = byId.get(edge.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          const force = (dist - restLength(edge.score)) * SIM.springK * (0.4 + edge.score) * alpha;
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
            const force = (SIM.repulsion / d2) * alpha;
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
      const { graph: g, selectedId: selected, focusCluster: focus, onlyHidden: hiddenOnly } = stateRef.current;
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

      for (const node of sim.nodes) node.onHidden = false;
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
      for (const node of sim.nodes) {
        const alpha = nodeAlpha(node);
        const radius = nodeRadius(node);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = clusterColor(node.cluster);
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
    simRef.current.nodes.findLast((node) => Math.hypot(node.x - point.x, node.y - point.y) <= nodeRadius(node) + 4);

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

  const selectedNode = graph?.nodes.find((node) => node.id === selectedId);
  const hiddenCount = graph?.edges.filter((edge) => edge.hidden).length || 0;

  return (
    <div className="graph-view" ref={wrapRef}>
      <canvas
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        ref={canvasRef}
      />
      {loading && (
        <div className="graph-loading"><Loader2 className="spin" size={22} /> Kaart berekenen...</div>
      )}
      {graph && (
        <aside className="graph-legend">
          <h3><Network size={15} /> Clusters</h3>
          {graph.clusters.filter((cluster) => cluster.size > 1).map((cluster) => (
            <button
              className={focusCluster === cluster.id ? "active" : ""}
              key={cluster.id}
              onClick={() => setFocusCluster((current) => (current === cluster.id ? null : cluster.id))}
              type="button"
            >
              <i style={{ background: clusterColor(cluster.id) }} />
              <span>{cluster.label}</span>
              <small>{cluster.size}</small>
            </button>
          ))}
          <div className="legend-actions">
            <button className={onlyHidden ? "active" : ""} onClick={() => setOnlyHidden((v) => !v)} type="button">
              <EyeOff size={13} /> Verborgen links ({hiddenCount})
            </button>
            <button onClick={resetView} title="Zoom terugzetten" type="button"><Maximize2 size={13} /></button>
          </div>
          <p className="legend-hint">Klik = selecteer · dubbelklik = open in lijst · sleep = verplaats</p>
        </aside>
      )}
      {selectedNode && (
        <aside className="graph-card">
          <div className="graph-card-head">
            <i style={{ background: clusterColor(selectedNode.cluster) }} />
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
          <RelatedRows graph={graph} limit={8} onSelect={setSelectedId} repoId={selectedNode.id} />
        </aside>
      )}
    </div>
  );
}
