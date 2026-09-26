import { useEffect, useMemo, useState } from "react";
import type { RealityCommit } from "@realityfork/shared";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export function App() {
  const [commits, setCommits] = useState<RealityCommit[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${apiUrl}/api/commits`)
      .then((response) => response.json())
      .then((data) => setCommits(data.commits ?? []))
      .catch(() => setError("API unavailable. Start the API or use the demo seed request in the README."));
  }, []);

  const subjectCount = useMemo(() => new Set(commits.map((commit) => commit.claim.subjectId)).size, [commits]);

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">TRIPLET / WEB3</span>
          <h1>RealityFork</h1>
          <p>One public record. Multiple observations. Every change remains inspectable.</p>
        </div>
        <div className="status"><i /> MVP ledger online</div>
      </header>

      <section className="summary">
        <article><strong>{commits.length}</strong><span>RealityCommits</span></article>
        <article><strong>{subjectCount}</strong><span>Public records</span></article>
        <article><strong>{commits.filter((item) => item.status === "challenged").length}</strong><span>Open conflicts</span></article>
      </section>

      <section className="workspace">
        <div className="section-heading">
          <div><span className="eyebrow">REALITY DIFF</span><h2>Road-condition branches</h2></div>
          <button onClick={() => location.reload()}>Refresh evidence</button>
        </div>

        {error && <p className="notice">{error}</p>}
        {!error && commits.length === 0 && (
          <div className="empty">
            <div className="fork-mark">Y</div>
            <h3>No claims yet</h3>
            <p>Create the sample commit from the README, then fork it with a conflicting observation.</p>
          </div>
        )}

        <div className="commit-grid">
          {commits.map((commit) => (
            <article className="commit" key={commit.id}>
              <div className="commit-top">
                <span className={`pill ${commit.status}`}>{commit.status}</span>
                <code>{commit.commitHash.slice(0, 10)}</code>
              </div>
              <h3>{commit.claim.subjectId}</h3>
              <p><b>{commit.claim.field}</b> {commit.claim.value}</p>
              <dl>
                <div><dt>Evidence</dt><dd>{Math.round(commit.evidenceStrength * 100)}%</dd></div>
                <div><dt>Source</dt><dd>{Math.round(commit.sourceReputation * 100)}%</dd></div>
                <div><dt>Parents</dt><dd>{commit.parentIds.length}</dd></div>
              </dl>
              {commit.contradictionFlags.map((flag) => <small key={flag}>{flag}</small>)}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
