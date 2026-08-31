import { useEffect, useState } from "react";
import type { AgentSummary } from "@bugbaar/api";
import { api } from "../api/client.ts";
import { Card, Empty, ErrorBanner } from "../components.tsx";

export function AgentsView() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [tools, setTools] = useState<{ name: string; description: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [id, setId] = useState("");
  const [goal, setGoal] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const refresh = async (): Promise<void> => {
    try {
      const [agentList, toolList] = await Promise.all([api.listAgents(), api.listTools()]);
      setAgents(agentList.agents);
      setTools(toolList.tools);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.createAgent({ id: id.trim(), goal: goal.trim() || undefined, tools: selectedTools });
      setId("");
      setGoal("");
      setSelectedTools([]);
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (agentId: string): Promise<void> => {
    try {
      await api.deleteAgent(agentId);
      await refresh();
    } catch (caught) {
      setError(caught);
    }
  };

  const toggleTool = (name: string): void => {
    setSelectedTools((current) =>
      current.includes(name) ? current.filter((tool) => tool !== name) : [...current, name],
    );
  };

  return (
    <div className="stack">
      <ErrorBanner error={error} />

      <Card title="Create an agent" hint="An agent can only call the tools you grant it here.">
        <div className="row">
          <div className="field">
            <label htmlFor="agent-id">Agent id</label>
            <input
              id="agent-id"
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="researcher"
            />
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="agent-goal">Goal (optional)</label>
            <input
              id="agent-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Answer questions about our documentation."
            />
          </div>
          <button className="action" onClick={() => void create()} disabled={busy || id.trim() === ""}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>

        {tools.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <span className="muted">Tools</span>
            <div className="row" style={{ marginTop: 6, gap: 14 }}>
              {tools.map((tool) => (
                <label
                  key={tool.name}
                  className="muted"
                  style={{ display: "flex", gap: 6, flex: "0 0 auto" }}
                  title={tool.description}
                >
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={selectedTools.includes(tool.name)}
                    onChange={() => toggleTool(tool.name)}
                  />
                  <code>{tool.name}</code>
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <Card title={`Agents (${agents.length})`}>
        {agents.length === 0 ? (
          <Empty>No agents yet. Create one above.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Name</th>
                <th>Tools</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td>
                    <code>{agent.id}</code>
                  </td>
                  <td>{agent.name}</td>
                  <td className="muted">{agent.tools.length > 0 ? agent.tools.join(", ") : "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="action danger" onClick={() => void remove(agent.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
