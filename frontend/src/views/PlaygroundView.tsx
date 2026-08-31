import { useEffect, useRef, useState } from "react";
import type { AgentSummary, RunAgentResponse } from "@bugbaar/api";
import { api, streamAgentRun, type AgentEvent } from "../api/client.ts";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Status, formatDuration } from "../components.tsx";
import { Icon } from "../icons.tsx";

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

/*
 * The execution surface: prompt on the left, live response in the centre,
 * execution metadata on the right.
 *
 * Everything on the right is derived from events the server actually sent —
 * elapsed time is measured locally, steps and tool outcomes come from the
 * stream. No token counts are shown, because the engine does not report them.
 */
export function PlaygroundView() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("What is 6 times 7?");
  const [sessionId, setSessionId] = useState("playground");

  const [text, setText] = useState("");
  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [result, setResult] = useState<RunAgentResponse | null>(null);
  const [runId, setRunId] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const startedAt = useRef(0);
  const output = useRef<HTMLPreElement>(null);

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

  // A single interval drives the elapsed clock; no per-frame loop.
  useEffect(() => {
    if (!running) return;

    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 100);
    return () => clearInterval(timer);
  }, [running]);

  // Keep the newest tokens in view while text streams in.
  useEffect(() => {
    output.current?.scrollTo({ top: output.current.scrollHeight });
  }, [text]);

  const applyEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case "run-start":
        setRunId(event.runId);
        break;

      case "step-start":
        setSteps((current) =>
          current.some((step) => step.index === event.index)
            ? current
            : [...current, { index: event.index, thought: "", tools: [] }],
        );
        break;

      case "token":
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

    startedAt.current = Date.now();
    setRunning(true);
    setElapsed(0);
    setText("");
    setSteps([]);
    setResult(null);
    setRunId("");
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
  const agent = agents.find((entry) => entry.id === agentId);
  const toolCalls = steps.flatMap((step) => step.tools);

  return (
    <>
      <PageHeader
        title="Playground"
        description="Runs stream over server-sent events. Text appears as the model produces it, and closing the stream cancels the run on the server."
        actions={
          running ? (
            <button className="btn ghost" onClick={stop}>
              {Icon.stop({ size: 13 })} Stop
            </button>
          ) : (
            <button className="btn" onClick={() => void run()} disabled={!agentId || !input.trim()}>
              {Icon.play({ size: 13 })} Run agent
            </button>
          )
        }
      />

      <ErrorState error={error} />

      {agents.length === 0 ? (
        <Card>
          <EmptyState
            icon={Icon.agents({ size: 18 })}
            title="No agents available"
            message="The playground runs an existing agent. Create one from the Agents page first."
          />
        </Card>
      ) : (
        <div className="split">
          <div className="stack">
            <Card title="Prompt" className="rise">
              <div className="stack">
                <div className="row">
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="pg-agent">Agent</label>
                    <select id="pg-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                      {agents.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="pg-session">Session</label>
                    <input
                      id="pg-session"
                      value={sessionId}
                      onChange={(event) => setSessionId(event.target.value)}
                      placeholder="playground"
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="pg-input">Message</label>
                  <textarea id="pg-input" value={input} onChange={(event) => setInput(event.target.value)} />
                </div>
              </div>
            </Card>

            <Card
              title="Response"
              className="rise"
              actions={
                running ? (
                  <Badge tone="live">
                    <span className="dot pulse" /> streaming
                  </Badge>
                ) : result ? (
                  <Status status={result.stoppedBecause} />
                ) : null
              }
            >
              <pre className="stream" ref={output} aria-live="polite">
                {text || (running ? "" : <span className="dim">Run the agent to see its response here.</span>)}
                {running ? <span className="caret" /> : null}
              </pre>
            </Card>
          </div>

          <div className="stack">
            <Card title="Execution" className="rise">
              <div className="stack" style={{ gap: 10 }}>
                <Row label="Status">
                  {running ? (
                    <Badge tone="live">
                      <span className="dot pulse" /> running
                    </Badge>
                  ) : result ? (
                    <Status status={result.stoppedBecause} />
                  ) : (
                    <span className="dim">idle</span>
                  )}
                </Row>

                <Row label="Elapsed">
                  <span className="mono">
                    {running ? formatDuration(elapsed) : result ? formatDuration(result.durationMs) : "—"}
                  </span>
                </Row>

                <Row label="Run id">
                  <span className="mono dim">{runId ? runId.slice(0, 8) : "—"}</span>
                </Row>

                <Row label="Steps">
                  <span className="mono">{steps.length}</span>
                </Row>

                <Row label="Tool calls">
                  <span className="mono">{toolCalls.length}</span>
                </Row>
              </div>
            </Card>

            <Card title="Agent" className="rise">
              {agent ? (
                <div className="stack" style={{ gap: 10 }}>
                  <Row label="Name">
                    <span className="truncate">{agent.name}</span>
                  </Row>
                  <Row label="Identifier">
                    <span className="mono dim">{agent.id}</span>
                  </Row>
                  <div>
                    <div className="dim" style={{ marginBottom: 5 }}>
                      Tools
                    </div>
                    <div className="inline">
                      {agent.tools.length > 0 ? (
                        agent.tools.map((tool) => (
                          <Badge key={tool} tone="accent" mono>
                            {tool}
                          </Badge>
                        ))
                      ) : (
                        <span className="dim">None granted</span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <span className="dim">Select an agent.</span>
              )}
            </Card>

            {steps.length > 0 ? (
              <Card title="Trace" className="rise">
                <div className="timeline">
                  {steps.map((step) => (
                    <div key={step.index}>
                      <div className="tl-item">
                        <span className="tl-node">
                          <span className="mono" style={{ fontSize: 10 }}>
                            {step.index + 1}
                          </span>
                        </span>
                        <div className="tl-body">
                          <div className="tl-title">Step {step.index + 1}</div>
                          {step.thought ? <div className="muted">{step.thought}</div> : null}
                        </div>
                      </div>

                      {step.tools.map((tool, index) => (
                        <div className="tl-item" key={`${tool.name}-${index}`}>
                          <span className={`tl-node ${tool.ok === undefined ? "live" : tool.ok ? "ok" : "danger"}`}>
                            {Icon.tool({ size: 11 })}
                          </span>
                          <div className="tl-body">
                            <div className="tl-title">
                              <span className="mono">{tool.name}</span>
                              {tool.ok === undefined ? (
                                <Badge tone="live">
                                  <span className="dot pulse" /> running
                                </Badge>
                              ) : (
                                <>
                                  <Badge tone={tool.ok ? "ok" : "danger"}>{tool.ok ? "ok" : "failed"}</Badge>
                                  <span className="mono dim">{formatDuration(tool.durationMs)}</span>
                                </>
                              )}
                            </div>
                            {tool.error ? <div className="muted">{tool.error}</div> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="inline" style={{ justifyContent: "space-between", gap: 12 }}>
      <span className="dim">{label}</span>
      {children}
    </div>
  );
}
