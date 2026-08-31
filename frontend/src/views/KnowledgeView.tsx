import { useEffect, useState } from "react";
import type { SearchResponse } from "@bugbaar/api";
import { api } from "../api/client.ts";
import { Card, Empty, ErrorBanner } from "../components.tsx";

export function KnowledgeView() {
  const [docId, setDocId] = useState("");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [chunks, setChunks] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const refreshStats = (): void => {
    api
      .knowledgeStats()
      .then(({ chunks: count }) => setChunks(count))
      .catch(() => setChunks(null));
  };

  useEffect(refreshStats, []);

  const ingest = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await api.ingest([{ id: docId.trim(), text }]);
      setNotice(
        `Indexed ${response.chunks} chunk${response.chunks === 1 ? "" : "s"} from ${response.documents} document.`,
      );
      setDocId("");
      setText("");
      setError(null);
      refreshStats();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const search = async (): Promise<void> => {
    setBusy(true);
    try {
      setResults(await api.search(query, topK));
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <ErrorBanner error={error} />
      {notice ? <div className="banner ok">{notice}</div> : null}

      <Card
        title="Ingest a document"
        hint="Text is chunked, embedded, and indexed. Re-using an id replaces that document's chunks."
      >
        <div className="field">
          <label htmlFor="doc-id">Document id</label>
          <input
            id="doc-id"
            value={docId}
            onChange={(event) => setDocId(event.target.value)}
            placeholder="handbook"
          />
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="doc-text">Text</label>
          <textarea id="doc-text" value={text} onChange={(event) => setText(event.target.value)} />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="action" onClick={() => void ingest()} disabled={busy || !docId.trim() || !text.trim()}>
            Ingest
          </button>
          {chunks !== null ? <span className="muted">{chunks} chunks indexed</span> : null}
        </div>
      </Card>

      <Card title="Semantic search">
        <div className="row">
          <div className="field" style={{ flex: 3 }}>
            <label htmlFor="kb-query">Query</label>
            <input
              id="kb-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && query.trim()) void search();
              }}
              placeholder="how do retries work"
            />
          </div>
          <div className="field" style={{ flex: 0, minWidth: 90 }}>
            <label htmlFor="kb-topk">Top K</label>
            <input
              id="kb-topk"
              type="number"
              min={1}
              max={50}
              value={topK}
              onChange={(event) => setTopK(Number(event.target.value))}
            />
          </div>
          <button className="action" onClick={() => void search()} disabled={busy || !query.trim()}>
            Search
          </button>
        </div>

        {results ? (
          results.hits.length === 0 ? (
            <Empty>
              No chunks scored above the relevance threshold. The offline hashing embedder has weak recall — set
              OPENAI_API_KEY for real embeddings.
            </Empty>
          ) : (
            <div className="stack" style={{ marginTop: 16 }}>
              {results.hits.map((hit) => (
                <div key={hit.chunkId} className="step succeeded">
                  <div className="row" style={{ gap: 10 }}>
                    <code>{hit.documentId}</code>
                    <span className="pill">{hit.score.toFixed(3)}</span>
                  </div>
                  <div style={{ marginTop: 6 }}>{hit.text}</div>
                </div>
              ))}
            </div>
          )
        ) : null}
      </Card>
    </div>
  );
}
