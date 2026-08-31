import { useState } from "react";
import { getApiKey, setApiKey } from "./api/client.ts";
import { AgentsView } from "./views/AgentsView.tsx";
import { KnowledgeView } from "./views/KnowledgeView.tsx";
import { MonitoringView } from "./views/MonitoringView.tsx";
import { PlaygroundView } from "./views/PlaygroundView.tsx";
import { WorkflowsView } from "./views/WorkflowsView.tsx";

const TABS = [
  { id: "agents", label: "Agents", render: () => <AgentsView /> },
  { id: "playground", label: "Playground", render: () => <PlaygroundView /> },
  { id: "knowledge", label: "Knowledge", render: () => <KnowledgeView /> },
  { id: "workflows", label: "Workflows", render: () => <WorkflowsView /> },
  { id: "monitoring", label: "Monitoring", render: () => <MonitoringView /> },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App() {
  const [tab, setTab] = useState<TabId>("agents");
  const [key, setKey] = useState(getApiKey());

  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  const saveKey = (value: string): void => {
    setKey(value);
    setApiKey(value);
  };

  return (
    <div className="shell">
      <header className="masthead">
        <h1>BugBaar Engine</h1>
        <span className="spacer" />
        <div className="field" style={{ flex: "0 0 auto", minWidth: 220 }}>
          <label htmlFor="api-key">API key</label>
          <input
            id="api-key"
            type="password"
            value={key}
            onChange={(event) => saveKey(event.target.value)}
            placeholder="dev-local-key"
            autoComplete="off"
          />
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            aria-current={entry.id === tab ? "page" : undefined}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main>{active.render()}</main>
    </div>
  );
}
