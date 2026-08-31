import { useCallback, useEffect, useState } from "react";
import type { AgentSummary } from "@bugbaar/api";
import { api } from "../api/client.ts";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton, formatWhen } from "../components.tsx";
import { Icon } from "../icons.tsx";

/*
 * Agents are presented as infrastructure resources rather than profile cards:
 * identifier, granted capabilities, and provenance, with the destructive
 * action kept quiet until hover.
 */
export function AgentsView({ onOpenPlayground }: { onOpenPlayground: () => void }) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [tools, setTools] = useState<{ name: string; description: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const [id, setId] = useState("");
  const [goal, setGoal] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [agentList, toolList] = await Promise.all([api.listAgents(), api.listTools()]);
      setAgents(agentList.agents);
      setTools(toolList.tools);
      setError(null);
    } catch (caught) {
      setError(caught);
      setAgents([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.createAgent({ id: id.trim(), goal: goal.trim() || undefined, tools: selected });
      setId("");
      setGoal("");
      setSelected([]);
      setCreating(false);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (agentId: string): Promise<void> => {
    try {
      await api.deleteAgent(agentId);
      await load();
    } catch (caught) {
      setError(caught);
    }
  };

  const toggle = (name: string): void =>
    setSelected((current) => (current.includes(name) ? current.filter((t) => t !== name) : [...current, name]));

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each agent is a stored definition — goal, instructions, and the tools it is permitted to call — rebuilt from the database when the engine restarts."
        actions={
          <>
            <button className="btn ghost" onClick={onOpenPlayground}>
              {Icon.play({ size: 13 })} Playground
            </button>
            <button className="btn" onClick={() => setCreating((open) => !open)}>
              {Icon.plus({ size: 14 })} New agent
            </button>
          </>
        }
      />

      <ErrorState error={error} onRetry={() => void load()} />

      {creating ? (
        <Card
          title="Create an agent"
          hint="An agent can only call the tools granted here. Unknown tool names are rejected by the API."
          className="rise"
          actions={
            <button className="icon-btn" onClick={() => setCreating(false)} aria-label="Cancel">
              {Icon.x({ size: 15 })}
            </button>
          }
        >
          <div className="stack">
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="agent-id">Agent id</label>
                <input
                  id="agent-id"
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  placeholder="researcher"
                />
              </div>
              <div className="field" style={{ flex: 2.4 }}>
                <label htmlFor="agent-goal">Goal (optional)</label>
                <input
                  id="agent-goal"
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="Answer questions about our documentation."
                />
              </div>
            </div>

            {tools.length > 0 ? (
              <div className="field">
                <label>Tools</label>
                <div className="inline">
                  {tools.map((tool) => (
                    <label
                      className="check"
                      key={tool.name}
                      title={tool.description}
                      data-on={selected.includes(tool.name)}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(tool.name)}
                        onChange={() => toggle(tool.name)}
                      />
                      {tool.name}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="inline">
              <button className="btn" onClick={() => void create()} disabled={busy || id.trim() === ""}>
                {busy ? "Creating…" : "Create agent"}
              </button>
              <button className="btn quiet" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      {agents === null ? (
        <div className="grid cards">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="card" key={index}>
              <Skeleton height={18} width="55%" />
              <div style={{ height: 10 }} />
              <Skeleton height={12} width="80%" />
              <div style={{ height: 14 }} />
              <Skeleton height={20} width="40%" />
            </div>
          ))}
        </div>
      ) : agents.length === 0 ? (
        <Card>
          <EmptyState
            icon={Icon.agents({ size: 18 })}
            title="No agents yet"
            message="An agent pairs a goal and a set of tools with the configured model provider. Create one to start running it."
            action={
              <button className="btn" onClick={() => setCreating(true)}>
                {Icon.plus({ size: 13 })} Create your first agent
              </button>
            }
          />
        </Card>
      ) : (
        <div className="grid cards">
          {agents.map((agent) => (
            <article className="card interactive rise" key={agent.id}>
              <div className="inline" style={{ marginBottom: 10 }}>
                <span className="metric-icon accent">{Icon.agents({ size: 14 })}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="strong truncate">{agent.name}</div>
                  <div className="mono dim truncate">{agent.id}</div>
                </div>
                <button
                  className="btn danger sm"
                  style={{ marginLeft: "auto" }}
                  onClick={() => void remove(agent.id)}
                  aria-label={`Delete ${agent.id}`}
                >
                  {Icon.trash({ size: 13 })}
                </button>
              </div>

              <div className="stack" style={{ gap: 10 }}>
                <div>
                  <div className="dim" style={{ marginBottom: 4 }}>
                    Tools
                  </div>
                  <div className="inline">
                    {agent.tools.length > 0 ? (
                      agent.tools.map((tool) => (
                        <Badge key={tool} tone="accent" mono>
                          {Icon.tool({ size: 11 })} {tool}
                        </Badge>
                      ))
                    ) : (
                      <span className="dim">None granted</span>
                    )}
                  </div>
                </div>

                <div className="inline" style={{ justifyContent: "space-between" }}>
                  <span className="dim">Created {formatWhen(agent.createdAt)}</span>
                  <button className="btn quiet sm" onClick={onOpenPlayground}>
                    Run {Icon.chevron({ size: 12 })}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
