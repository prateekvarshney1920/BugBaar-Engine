import { useEffect, useState, type ReactNode } from "react";
import { getApiKey, setApiKey } from "./api/client.ts";
import { Icon } from "./icons.tsx";
import { AgentsView } from "./views/AgentsView.tsx";
import { DeveloperView } from "./views/DeveloperView.tsx";
import { KnowledgeView } from "./views/KnowledgeView.tsx";
import { MonitoringView } from "./views/MonitoringView.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { PlaygroundView } from "./views/PlaygroundView.tsx";
import { RunsView } from "./views/RunsView.tsx";
import { WorkflowsView } from "./views/WorkflowsView.tsx";

/*
 * Navigation stays state-driven rather than routed.
 *
 * The application has never had a router, and adding one would be a
 * behavioural change dressed as a visual one. The sections below are the same
 * views as before, regrouped so the sidebar reads as a product structure
 * rather than a flat strip of tabs.
 */
type PageId = "overview" | "agents" | "playground" | "runs" | "workflows" | "knowledge" | "monitoring" | "developer";

interface PageDef {
  id: PageId;
  label: string;
  title: string;
  section: string;
  icon: ReactNode;
  render: (go: (page: PageId) => void) => ReactNode;
}

const PAGES: PageDef[] = [
  {
    id: "overview",
    label: "Overview",
    title: "Overview",
    section: "Platform",
    icon: Icon.overview(),
    render: (go) => <OverviewView onNavigate={go} />,
  },
  {
    id: "agents",
    label: "Agents",
    title: "Agents",
    section: "Agents",
    icon: Icon.agents(),
    render: (go) => <AgentsView onOpenPlayground={() => go("playground")} />,
  },
  {
    id: "playground",
    label: "Playground",
    title: "Playground",
    section: "Agents",
    icon: Icon.play(),
    render: () => <PlaygroundView />,
  },
  {
    id: "runs",
    label: "Agent Runs",
    title: "Agent Runs",
    section: "Agents",
    icon: Icon.runs(),
    render: () => <RunsView />,
  },
  {
    id: "workflows",
    label: "Workflows",
    title: "Workflows",
    section: "Orchestration",
    icon: Icon.workflows(),
    render: () => <WorkflowsView />,
  },
  {
    id: "knowledge",
    label: "Knowledge",
    title: "Knowledge Base",
    section: "Orchestration",
    icon: Icon.knowledge(),
    render: () => <KnowledgeView />,
  },
  {
    id: "monitoring",
    label: "Monitoring",
    title: "Monitoring",
    section: "Operations",
    icon: Icon.monitoring(),
    render: () => <MonitoringView />,
  },
  {
    id: "developer",
    label: "Developer",
    title: "Developer",
    section: "Operations",
    icon: Icon.developer(),
    render: () => <DeveloperView />,
  },
];

const SECTIONS = ["Platform", "Agents", "Orchestration", "Operations"];

export function App() {
  const [page, setPage] = useState<PageId>("overview");
  const [collapsed, setCollapsed] = useState(false);
  const [key, setKey] = useState(getApiKey());

  const active = PAGES.find((entry) => entry.id === page) ?? PAGES[0]!;

  // Focus jumps to the top of the content when the section changes, so the
  // keyboard does not have to walk back through the whole sidebar each time.
  useEffect(() => {
    document.getElementById("content")?.scrollTo({ top: 0 });
  }, [page]);

  const saveKey = (value: string): void => {
    setKey(value);
    setApiKey(value);
  };

  return (
    <div className="app" data-collapsed={collapsed}>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark">{Icon.bolt({ size: 15 })}</span>
          <span className="brand-name">
            BugBaar
            <small>Engine</small>
          </span>
        </div>

        <div className="nav">
          {SECTIONS.map((section) => (
            <div className="nav-section" key={section}>
              <div className="nav-label">{section}</div>
              {PAGES.filter((entry) => entry.section === section).map((entry) => (
                <button
                  key={entry.id}
                  className="nav-item"
                  data-tip={entry.label}
                  aria-current={entry.id === page ? "page" : undefined}
                  onClick={() => setPage(entry.id)}
                >
                  {entry.icon}
                  <span className="collapse-hide">{entry.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <button
            className="nav-item"
            data-tip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((current) => !current)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {Icon.panel({ size: 16 })}
            <span className="collapse-hide">Collapse</span>
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1>{active.title}</h1>
          <span className="crumb">/ {active.section}</span>

          <div style={{ marginLeft: "auto" }} className="inline">
            <div className="field" style={{ width: 190 }}>
              <input
                id="api-key"
                type="password"
                value={key}
                onChange={(event) => saveKey(event.target.value)}
                placeholder="API key (optional in dev)"
                autoComplete="off"
                aria-label="API key"
              />
            </div>
          </div>
        </header>

        <main className="content" id="content">
          {/* Keying on the page id restarts the entrance animation per view. */}
          <div className="page" key={active.id}>
            {active.render(setPage)}
          </div>
        </main>
      </div>
    </div>
  );
}
