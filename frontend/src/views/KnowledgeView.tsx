import { useCallback, useEffect, useState } from "react";
import type { SearchResponse } from "@bugbaar/api";
import { api } from "../api/client.ts";
import { Badge, Card, EmptyState, ErrorState, Metric, PageHeader, Skeleton } from "../components.tsx";
import { Icon } from "../icons.tsx";

/*
 * The knowledge base: ingest text, then retrieve against it.
 *
 * Relevance scores shown here are the cosine scores the API returns, not a
 * derived percentage. The interface deliberately offers plain text only,
 * because that is all the backend accepts today.
 */
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
  const [searching, setSearching] = useState(false);

  const refreshStats = useCallback((): void => {
    api
      .knowledgeStats()
      .then(({ chunks: count }) => setChunks(count))
      .catch(() => setChunks(null));
  }, []);

  useEffect(refreshStats, [refreshStats]);

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
    setSearching(true);
    try {
      setResults(await api.search(query, topK));
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Knowledge base"
        description="Documents are chunked on sentence boundaries, embedded, and indexed for semantic retrieval. Re-using an id replaces that document's chunks."
      />

      <ErrorState error={error} />

      {notice ? (
        <div className="banner ok rise" role="status">
          <span style={{ marginTop: 2 }}>{Icon.check({ size: 15 })}</span>
          <div>{notice}</div>
        </div>
      ) : null}

      <div className="grid metrics">
        <Metric
          label="Indexed chunks"
          value={chunks}
          foot={chunks === 0 ? "Nothing ingested yet" : "Across all documents"}
          icon={Icon.database({ size: 14 })}
          accent="accent"
        />
      </div>

      <div className="split">
        <Card title="Retrieve" className="rise">
          <div className="stack">
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
              <div className="field" style={{ width: 84, flex: "0 0 auto" }}>
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
              <button className="btn" onClick={() => void search()} disabled={searching || !query.trim()}>
                {Icon.search({ size: 13 })} Search
              </button>
            </div>

            {searching ? (
              <div className="stack">
                <Skeleton height={54} />
                <Skeleton height={54} />
              </div>
            ) : results ? (
              results.hits.length === 0 ? (
                <EmptyState
                  icon={Icon.search({ size: 18 })}
                  title="No matches above the relevance threshold"
                  message="The offline hashing embedder has weak recall — it matches on exact word overlap. Set OPENAI_API_KEY for semantic embeddings."
                />
              ) : (
                <div className="stack" style={{ gap: 10 }}>
                  {results.hits.map((hit) => (
                    <article className="metric" key={hit.chunkId}>
                      <div className="inline">
                        <Badge mono>
                          {Icon.doc({ size: 11 })} {hit.documentId}
                        </Badge>
                        <span className="mono dim" style={{ marginLeft: "auto" }}>
                          {hit.score.toFixed(3)}
                        </span>
                      </div>
                      {/* The bar is the API's own cosine score, clamped for display. */}
                      <div className="meter" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, Math.max(0, hit.score * 100))}%` }} />
                      </div>
                      <p style={{ margin: 0, fontSize: 13 }}>{hit.text}</p>
                    </article>
                  ))}
                </div>
              )
            ) : (
              <EmptyState
                icon={Icon.search({ size: 18 })}
                title="Search the knowledge base"
                message="Enter a query to retrieve the most semantically similar chunks, ranked by cosine score."
              />
            )}
          </div>
        </Card>

        <Card
          title="Ingest a document"
          hint="Plain text only — the backend does not parse PDF or DOCX."
          className="rise"
        >
          <div className="stack">
            <div className="field">
              <label htmlFor="doc-id">Document id</label>
              <input
                id="doc-id"
                value={docId}
                onChange={(event) => setDocId(event.target.value)}
                placeholder="handbook"
              />
            </div>
            <div className="field">
              <label htmlFor="doc-text">Text</label>
              <textarea id="doc-text" value={text} onChange={(event) => setText(event.target.value)} />
            </div>
            <div>
              <button className="btn" onClick={() => void ingest()} disabled={busy || !docId.trim() || !text.trim()}>
                {busy ? "Indexing…" : "Ingest"}
              </button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
