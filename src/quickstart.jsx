import { t } from "./i18n.js";
import React, { useEffect, useState } from "react";
import { Activity, AlertTriangle, Container, Copy, FolderOpen, GitBranch, Globe, List, Loader2, Play, RefreshCcw, Square, Stethoscope, Zap } from "lucide-react";
import { checkUpdatesAll, diagnoseRepo, loadProblems, loadRuntimes, openLocalRepo, pullRepo, startContainer, startRepo, stopRepo } from "./api";
import { languageColor } from "./format";

const uptime = (startedAt) => {
  if (!startedAt) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 60000));
  if (minutes < 1) return t("net gestart");
  if (minutes < 60) return `${minutes} min`;
  return t("{0}u {1}m", [Math.floor(minutes / 60), minutes % 60]);
};

const firstLine = (text) => String(text || "").split("\n").find((line) => line.trim()) || "";

// Snelstart: alle gekloonde repos op één tab — start/stop, waar draait het,
// updates-check over alles tegelijk, en de link zodra een app z'n URL meldt.
export function QuickstartView({ dups = {}, onOpenRepo }) {
  const [items, setItems] = useState(null);
  const [behind, setBehind] = useState({});
  const [checkedAt, setCheckedAt] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [problems, setProblems] = useState([]);

  useEffect(() => {
    let active = true;
    const load = () => {
      loadRuntimes()
        .then((data) => {
          if (active) {
            setItems(data.items || []);
            setError("");
          }
        })
        .catch((err) => active && setError(err.message));
      loadProblems()
        .then((data) => active && setProblems(data.problems || []))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 3500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const diagnose = async (problem) => {
    setBusy(`diag:${problem.id}`);
    setError("");
    try {
      await diagnoseRepo(problem);
      setProblems((await loadProblems()).problems || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const act = async (item, action) => {
    setBusy(`${action}:${item.id}`);
    setError("");
    if (action === "start") setWarning("");
    try {
      const starter = item.containerMode ? startContainer : startRepo;
      const data = await ({ start: starter, stop: stopRepo, open: openLocalRepo, pull: pullRepo }[action])(item);
      if (action === "start" && data.portWarning) setWarning(data.portWarning);
      if (action === "pull") setBehind((map) => ({ ...map, [item.id]: 0 }));
      if (action !== "open") setItems((await loadRuntimes()).items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const checkAll = async () => {
    setBusy("updates");
    setError("");
    try {
      const data = await checkUpdatesAll();
      setBehind(Object.fromEntries((data.items || []).map((entry) => [entry.id, entry.behind])));
      setCheckedAt(data.checkedAt || new Date().toISOString());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  if (!items) {
    return <div className="quickstart-empty"><Loader2 className="spin" size={22} />{" "}{t("Clones zoeken...")}</div>;
  }
  if (!items.length) {
    return (
      <div className="quickstart-empty">
        <Zap size={34} />
        <h2>{t("Nog geen gekloonde repos")}</h2>
        <p>{t("Klonen doe je vanuit de lijst — daarna staan ze hier klaar om te starten.")}</p>
      </div>
    );
  }

  const runningCount = items.filter((item) => item.running).length;
  const behindTotal = Object.values(behind).filter((count) => count > 0).length;

  return (
    <div className="quickstart">
      <div className="quickstart-head">
        <h2><Zap size={18} />{" "}{t("Snelstart")}</h2>
        <span>{items.length}{" "}{t("gekloond ·")}{" "}{runningCount}{" "}{t("draaiend")}{checkedAt ? t(" · {0} met updates", [behindTotal]) : ""}</span>
        <button className="updates-btn" disabled={busy === "updates"} onClick={checkAll} type="button">
          {busy === "updates" ? <Loader2 className="spin" size={14} /> : <RefreshCcw size={14} />}{" "}{t("Check alle updates")}</button>
        {error && <span className="quickstart-error">{t(error)}</span>}
      </div>
      {warning && (
        <div className="port-warning"><AlertTriangle size={15} /> {t(warning)}</div>
      )}
      {problems.length > 0 && (
        <div className="problems-block">
          <div className="problems-head">
            <AlertTriangle size={15} />{" "}{t("Problemen ({0})", [problems.length])}
          </div>
          {problems.map((problem) => (
            <div className="problem-item" key={problem.id}>
              <div className="problem-row">
                <button className="problem-name" onClick={() => onOpenRepo(problem.id)} title={t("Open in lijst")} type="button">
                  {problem.fullName}
                </button>
                <span className="problem-msg">[{problem.error.op}] {firstLine(problem.error.message)}</span>
                <button
                  className="problem-diag"
                  disabled={busy === `diag:${problem.id}`}
                  onClick={() => diagnose(problem)}
                  title={t("Laat AI (lokale Ollama) de foutlog analyseren")}
                  type="button"
                >
                  {busy === `diag:${problem.id}` ? <Loader2 className="spin" size={13} /> : <Stethoscope size={13} />}{" "}{t("AI-diagnose")}
                </button>
              </div>
              {problem.diagnosis && <pre className="problem-advice">{problem.diagnosis.advice}</pre>}
            </div>
          ))}
        </div>
      )}
      <div className="quickstart-grid">
        {items.map((item) => {
          const behindCount = behind[item.id] || 0;
          return (
            <article className={`runcard ${item.running ? "running" : ""}`} key={item.id}>
              <div className="runcard-head">
                <span className={`run-dot ${item.running ? "on" : ""}`} title={item.running ? t("Draait") : t("Gestopt")} />
                <strong>{item.name}</strong>
                <small>{item.owner}</small>
                {item.language && <i className="lang-dot" style={{ background: languageColor(item.language) }} title={item.language} />}
              </div>
              <div className="runcard-meta">
                <span className="run-type">{item.type}</span>
                {item.installStatus === "installed" && <span className="run-installed">{t("geïnstalleerd")}</span>}
                {!item.running && item.lastPort && <span className="run-port" title={item.lastUrl}>{t("meestal :")}{item.lastPort}</span>}
                {behindCount > 0 && <span className="run-behind">{behindCount}{" "}{t("achter")}</span>}
                {item.containerMode && <span className="run-container" title={t("Start gebeurt in een Docker-container")}><Container size={11} /> container</span>}
                {dups[item.id] && <span className="run-dup" title={dups[item.id]}><Copy size={11} />{" "}{t("ook elders")}</span>}
                {item.running && (
                  <span className="run-live"><Activity size={12} /> PID {item.pid} · {uptime(item.startedAt)}{item.mode === "container" ? " · in container" : ""}</span>
                )}
              </div>
              {item.running && item.url && (
                <a className="run-url" href={item.url} rel="noreferrer" target="_blank">
                  <Globe size={14} /> {item.url}
                </a>
              )}
              {!item.running && item.startLabel && <code className="run-cmd">{item.startLabel}</code>}
              <div className="runcard-actions">
                {item.running ? (
                  <button className="danger" disabled={busy === `stop:${item.id}`} onClick={() => act(item, "stop")} type="button">
                    {busy === `stop:${item.id}` ? <Loader2 className="spin" size={15} /> : <Square size={15} />} Stop
                  </button>
                ) : (
                  <button className="primary" disabled={!item.canStart || busy === `start:${item.id}`} onClick={() => act(item, "start")} title={item.canStart ? item.startLabel : t("Geen startcommando gedetecteerd")} type="button">
                    {busy === `start:${item.id}` ? <Loader2 className="spin" size={15} /> : <Play size={15} />} Start
                  </button>
                )}
                {behindCount > 0 && (
                  <button disabled={busy === `pull:${item.id}`} onClick={() => act(item, "pull")} title="git pull --ff-only" type="button">
                    {busy === `pull:${item.id}` ? <Loader2 className="spin" size={15} /> : <GitBranch size={15} />} Pull
                  </button>
                )}
                <button onClick={() => act(item, "open")} title={t("Open map in verkenner")} type="button"><FolderOpen size={15} /></button>
                <button onClick={() => onOpenRepo(item.id)} title={t("Open in lijst")} type="button"><List size={15} /></button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
