# 🧠 BugBaar Engine

> **Open-source infrastructure for AI Agents, workflow automation, and intelligent systems.**

BugBaar Engine is an open-source platform for building, deploying, and orchestrating AI-native applications. It provides the infrastructure developers need to create autonomous agents, intelligent workflows, retrieval systems, and scalable AI services.

Our mission is to make AI infrastructure modular, developer-friendly, and accessible to everyone.

---

# ⚡ Quick Start

```bash
npm install
cp .env.example .env
npm run build
npm run dev
```

The engine listens on `http://localhost:4000`. It runs with **zero external
infrastructure** out of the box — in-memory agent memory, an in-memory vector
store, and an offline echo LLM provider — so every endpoint works before you
add a single credential.

```bash
curl -s -X POST http://localhost:4000/v1/agents/assistant/run   -H 'content-type: application/json'   -H 'x-api-key: dev-local-key'   -d '{"input":"What is 6 times 7?"}'
```

Point it at a real model by setting `LLM_PROVIDER=openai` and `OPENAI_API_KEY`
in `.env`, or `LLM_PROVIDER=ollama` for a local one.

To run the dashboard alongside it:

```bash
npm run dev:frontend   # http://localhost:5173
```

For the full stack (MongoDB, Redis, Qdrant):

```bash
docker compose up --build
```

## 📖 Documentation

| Guide                                              | Contents                                            |
| -------------------------------------------------- | --------------------------------------------------- |
| [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) | Install, first agent, first knowledge base          |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)       | Module boundaries, the agent loop, extension points |
| [docs/API.md](docs/API.md)                         | Every REST endpoint                                 |
| [docs/SECURITY.md](docs/SECURITY.md)               | Agent threat model and tool-safety rules            |
| [frontend/README.md](frontend/README.md)           | The dashboard: views, proxying, build               |
| [CONTRIBUTING.md](CONTRIBUTING.md)                 | Setup, standards, how to add a tool                 |

## 📦 Implementation Status

| Module                                                                    | Status                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------- |
| Agent runtime (loop, memory, tool calling)                                | ✅ Implemented                                 |
| Tool registry and schema validation                                       | ✅ Implemented                                 |
| RAG engine (chunking, embeddings, retrieval)                              | ✅ Implemented                                 |
| Workflow engine (retries, timeouts, events, scheduling)                   | ✅ Implemented                                 |
| API gateway (auth, rate limiting, REST)                                   | ✅ Implemented                                 |
| Qdrant vector store                                                       | ✅ Implemented, verified against a live server |
| MongoDB persistence (agents, memory, run history)                         | ✅ Implemented                                 |
| BullMQ queue + shared rate limiting                                       | ✅ Implemented                                 |
| Streaming agent runs (SSE, token by token)                                | ✅ Implemented                                 |
| Lint, formatting, and API test suite in CI                                | ✅ Implemented                                 |
| Observability (Prometheus metrics, structured logs)                       | ✅ Implemented                                 |
| Multi-agent communication                                                 | 🚧 Event bus in place, protocol pending        |
| Frontend dashboard (agents, playground, knowledge, workflows, monitoring) | ✅ Implemented                                 |

---

# 🤔 Why BugBaar Engine?

Building AI applications today requires stitching together multiple frameworks, APIs, vector databases, and orchestration tools.

Developers spend more time integrating infrastructure than building intelligent products.

BugBaar Engine provides a unified platform to accelerate AI development.

---

# 🎯 Vision

Build the world's leading open-source AI application platform.

A platform where developers can:

- 🤖 Build AI Agents
- 🔄 Automate Workflows
- 🧠 Create Intelligent Systems
- 🔌 Connect Tools
- 📚 Build Knowledge Bases
- ⚡ Deploy AI Applications
- 🌍 Scale Multi-Agent Systems

---

# 🚀 Mission

Empower developers to build production-ready AI systems faster through modular infrastructure, reusable components, and an open ecosystem.

---

# 🧩 Platform Modules

## 🤖 AI Agents

Build autonomous AI agents.

### Features

- Agent Builder
- Agent Memory
- Goal Management
- Tool Calling
- Multi-Agent Communication

---

## 🔄 Workflow Automation

Create intelligent workflows.

### Features

- Workflow Builder
- Task Orchestration
- Event Triggers
- Background Jobs
- Retry & Scheduling

---

## 📚 Knowledge Engine

Power AI with knowledge.

### Features

- Document Processing
- Semantic Search
- Embeddings
- Knowledge Base
- Context Retrieval

---

## 🧠 RAG Engine

Build Retrieval-Augmented Generation applications.

### Features

- Document Chunking
- Vector Search
- Retrieval Pipeline
- Context Ranking
- Prompt Injection Prevention

---

## 🔌 Tool Integration

Connect AI with external systems.

### Features

- REST APIs
- Database Connectors
- File Processing
- Email Integration
- Third-Party APIs

---

## 📡 API Gateway

Expose AI services securely.

### Features

- REST APIs
- Authentication
- Rate Limiting
- API Keys
- Usage Analytics

---

## 📊 Monitoring & Observability

Understand how AI systems perform.

### Features

- Logs
- Metrics
- Agent Traces
- Workflow Monitoring
- Error Tracking

---

## 🛡 Security

Secure AI applications by design.

### Features

- Authentication
- Authorization
- Secret Management
- Audit Logs
- Access Control

---

# 🌍 Supported Use Cases

BugBaar Engine can power:

- AI Assistants
- Customer Support Bots
- Coding Agents
- Research Assistants
- Knowledge Management Systems
- Workflow Automation
- Internal Enterprise Tools
- Developer Platforms
- Recruitment AI
- Education Platforms

---

# 🏗 Technology Stack

## Runtime

- Node.js
- TypeScript

## Backend

- Express.js

## AI Frameworks

- OpenAI SDK
- LangChain
- Vercel AI SDK
- Ollama

## Database

- MongoDB

## Vector Database

- Qdrant

## Cache

- Redis

## Queue

- BullMQ

## Storage

- Cloudinary / AWS S3

## Infrastructure

- Docker
- GitHub Actions
- Nginx

## APIs

- REST APIs
- WebSockets

---

# 📂 Repository Structure

```text
bugbaar-engine
│
├── agents/
├── workflows/
├── rag/
├── persistence/
├── queue/
├── tools/
├── api/
├── frontend/
├── backend/
├── docs/
├── infrastructure/
├── scripts/
├── .github/
├── README.md
├── CONTRIBUTING.md
├── LICENSE
└── docker-compose.yml
```

---

# 🚧 Current Development Areas

We're actively looking for contributors in:

## 🤖 AI

- Agent Framework
- Memory System
- Multi-Agent Communication
- RAG Pipeline
- Tool Calling

## 💻 Backend

- API Gateway
- Authentication
- Workflow Engine
- Queue System
- Event Bus

## 🎨 Frontend

- Agent Dashboard
- Workflow Builder
- Monitoring Dashboard
- Playground

## 📖 Documentation

- Architecture
- SDK Documentation
- API Reference
- Tutorials
- Examples

## ⚙ Infrastructure

- Docker
- CI/CD
- Monitoring
- Deployment

---

# 🌱 Good First Issues

Perfect for first-time contributors.

- Documentation
- Example Agents
- Bug Fixes
- API Improvements
- Unit Tests

Look for:

- `good-first-issue`
- `help-wanted`
- `documentation`

---

# 🤝 Contributing

We welcome:

- AI Engineers
- Backend Engineers
- Frontend Engineers
- DevOps Engineers
- Technical Writers
- Product Designers
- Open Source Contributors

Every contribution helps developers build better AI systems.

---

# 🌎 Long-Term Vision

BugBaar Engine aims to become the open infrastructure powering the next generation of AI-native applications.

Imagine a world where:

- Developers build AI products without reinventing infrastructure.
- AI agents collaborate across applications.
- Workflows are intelligent, autonomous, and scalable.
- Organizations deploy production-ready AI in days instead of months.
- Open-source AI infrastructure is accessible to everyone.

This is the future we're building.

---

# ❤️ Join the Mission

If you're passionate about:

- Artificial Intelligence
- AI Agents
- Workflow Automation
- Open Source
- Developer Infrastructure
- Building Products That Matter

We'd love to build with you.

⭐ Star the repository

🐛 Report issues

🚀 Submit a Pull Request

🤝 Become a Founding Contributor

---

## Built by the **BugBaar Global** Community.

### **Powering the Next Generation of AI Applications.**
