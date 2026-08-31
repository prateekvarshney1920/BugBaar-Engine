import { useEffect, useRef, useState } from "react";
import type { AgentSummary, RunAgentResponse } from "@bugbaar/api";
import { api, streamAgentRun, type AgentEvent } from "../api/client.ts";
import { Card, Empty, ErrorBanner, formatDuration, Pill } from "../components.tsx";

interface LiveTool {
  name: string;
  ok?: boolean;
  durationMs?: number;
  error?: string;
}

interface LiveStep {
  index: number;
  thought: string;
  tools: LiveTool[];
}

export function PlaygroundView() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("What is 6 times 7?");
  const [sessionId, setSessionId] = useState("playground");

  const [text, setText] = useState("");
  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [result, setResult] = useState<RunAgentResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api
      .listAgents()
      .then(({ agents: list }) => {
        setAgents(list);
        setAgentId((current) => current || list[0]?.id || "");
      })
      .catch(setError);
  }, []);

  // Never leave a stream running behind an unmounted view.
  useEffect(() => () => abortRef.current?.abort(), []);

  const applyEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case "step-start":
        setSteps((current) =>
          current.some((step) => step.index === event.index)
            ? current
            : [...current, { index: event.index, thought: "", tools: [] }],
        );
        break;

      case "token":
        // Tokens for a new step start a fresh block of text rather than
        // appending to the previous step's reasoning.
        setText((current) => current + event.text);
        break;

      case "message":
        setSteps((current) =>
          current.map((step) => (step.index === event.index ? { ...step, thought: event.content } : step)),
        );
        break;

      case "tool-start":
        setSteps((current) =>
          current.map((step) =>
            step.index === event.index ? { ...step, tools: [...step.tools, { name: event.call.name }] } : step,
          ),
        );
        break;

      case "tool-result":
        setSteps((current) =>
          current.map((step) =>
            step.index === event.index
              ? {
                  ...step,
                  tools: step.tools.map((tool) =>
                    tool.name === event.result.name && tool.ok === undefined
                      ? {
                          name: tool.name,
                          ok: event.result.ok,
                          durationMs: event.result.durationMs,
                          error: event.result.error,
                        }
                      : tool,
                  ),
                }
              : step,
          ),
        );
        break;

      case "run-end":
        setResult(event.result);
        break;

      case "error":
        setError(new Error(event.message));
        break;

      default:
        break;
    }
  };

  const run = async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setText("");
    setSteps([]);
    setResult(null);
    setError(null);

    try {
      for await (const event of streamAgentRun(agentId, input, {
        sessionId: sessionId || undefined,
        signal: controller.signal,
      })) {
        applyEvent(event);
      }
    } catch (caught) {
      // An abort is the user's own doing, not a failure worth reporting.
      if (!controller.signal.aborted) setError(caught);
    } finally {
      setRunning(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const stop = (): void => abortRef.current?.abort();

  return (
    <div className="stack">
      <ErrorBanner error={error} />

      <Card title="Playground" hint="Runs stream live: text appears as the model produces it.">
        <div className="row">
          <div className="field">
            <label htmlFor="pg-agent">Agent</label>
            <select id="pg-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.length === 0 ? <option value="">No agents available</option> : null}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.id}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pg-session">Session id</label>
            <input
              id="pg-session"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="playground"
            />
          </div>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="pg-input">Prompt</label>
          <textarea id="pg-input" value={input} onChange={(event) => setInput(event.target.value)} />
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="action" onClick={() => void run()} disabled={running || !agentId || !input.trim()}>
            {running ? "Streaming…" : "Run agent"}
          </button>
          {running ? (
            <button className="action ghost" onClick={stop}>
              Stop
            </button>
          ) : null}
        </div>
      </Card>

      {running || text || result ? (
        <Card title="Response">
          <div className="row" style={{ gap: 16, marginBottom: 12 }}>
            {result ? <Pill status={result.stoppedBecause} /> : <Pill status="streaming" />}
            {result ? <span className="muted">{formatDuration(result.durationMs)}</span> : null}
            {result ? <span className="muted mono">run {result.runId.slice(0, 8)}</span> : null}
          </div>

          <pre aria-live="polite">
            {text || (running ? "…" : "(empty response)")}
            {running ? <span className="cursor" /> : null}
          </pre>
        </Card>
      ) : null}

      {steps.length > 0 ? (
        <Card title={`Steps (${steps.length})`}>
          {steps.map((step) => (
            <div key={step.index} className="step succeeded">
              <div className="muted">Step {step.index + 1}</div>
              {step.thought ? <div style={{ margin: "4px 0" }}>{step.thought}</div> : null}
              {step.tools.map((tool, index) => (
                <div key={`${tool.name}-${index}`} className="row" style={{ gap: 10, marginTop: 4 }}>
                  <code>{tool.name}</code>
                  {tool.ok === undefined ? (
                    <Pill status="running" />
                  ) : (
                    <Pill status={tool.ok ? "succeeded" : "failed"} />
                  )}
                  {tool.durationMs !== undefined ? (
                    <span className="muted">{formatDuration(tool.durationMs)}</span>
                  ) : null}
                  {tool.error ? (
                    <span className="muted" style={{ color: "var(--error)" }}>
                      {tool.error}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </Card>
      ) : result?.steps.length === 0 ? (
        <Card title="Steps">
          <Empty>The agent answered directly, without calling any tools.</Empty>
        </Card>
      ) : null}
    </div>
  );
}
