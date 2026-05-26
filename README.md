# Consumer Pipeline

Unified Kafka consumer pipeline that reads from the sessions and skills producer topics and writes to purpose-built data stores.

## Architecture

```
┌──────────────────────┐     ┌──────────────────────┐
│ claude-sessions-      │     │ skills-intelligence-  │
│ pipeline (producer)   │     │ pipeline (producer)   │
│                       │     │                       │
│ sessions.raw          │     │ skills.raw            │
│ sessions.analyzed     │     │ skills.analyzed       │
│ sessions.tools        │     │ skills.entities       │
│ sessions.files        │     │ skills.dependencies   │
└───────────┬───────────┘     └───────────┬───────────┘
            │         ┌───────────┐       │
            └────────►│   Kafka   │◄──────┘
                      └─────┬─────┘
         ┌──────────────────┼──────────────────┐
         │                  │                  │
    ┌────▼─────┐     ┌─────▼────┐     ┌──────▼──────┐
    │ ChromaDB │     │ClickHouse│     │  Wikipedia  │
    │ Consumer │     │ Consumer │     │  Consumer   │
    │          │     │          │     │             │
    │ Vector   │     │ Analytics│     │ Articles +  │
    │ chunks   │     │ tables   │     │ keyword     │
    │ for RAG  │     │ + views  │     │ linking     │
    └──────────┘     └──────────┘     └─────────────┘
         │                  │                  │
    ┌────▼─────┐     ┌─────▼────┐     ┌──────▼──────┐
    │  Graph   │     │  Skill   │     │    Eval     │
    │ Consumer │     │ Updater  │     │  Consumer   │
    │          │     │ Consumer │     │             │
    │ BM25 +   │     │ Generate │     │ Test cases  │
    │ PageRank │     │ new      │     │ + trigger   │
    │ Neo4j    │     │ skills   │     │ validation  │
    └──────────┘     └──────────┘     └─────────────┘
```

## Consumers

| Consumer | Kafka Topics | Output | Purpose |
|----------|-------------|--------|---------|
| **ChromaDB** | `skills.analyzed`, `sessions.analyzed` | ChromaDB collections | Vector chunks for RAG retrieval over skills and session data |
| **ClickHouse** | All 8 topics | ClickHouse tables + MVs | Analytics warehouse for skill maps, session metrics, entity relationships |
| **Wikipedia** | `skills.analyzed`, `sessions.analyzed` | Markdown articles in `output/wiki/` | Auto-generated articles about skills, topics, sessions with `[[keyword]]` linking |
| **Graph** | `skills.analyzed`, `sessions.analyzed` | Neo4j graph | BM25 search + PageRank + similarity connections between skills, articles, workflows |
| **Skill Updater** | `skills.analyzed`, `sessions.analyzed` | Generated SKILL.md files | Creates new script/fundamental/orchestration skills based on gaps detected |
| **Eval** | `skills.analyzed`, `sessions.analyzed` | JSON test suites | Test cases per skill + trigger validation tests from real session patterns |

## Quick Start

```bash
# Start infrastructure
npm run infra:up

# Install dependencies
npm install

# Run all consumers
npm start

# Or run individually
npm run consumer:chromadb
npm run consumer:clickhouse
npm run consumer:wikipedia
npm run consumer:graph
npm run consumer:skill-updater
npm run consumer:eval
```

## Infrastructure

- **Kafka** — localhost:9092 (shared with producer pipelines)
- **ChromaDB** — localhost:8000
- **ClickHouse** — localhost:8123 (HTTP), localhost:9000 (native)
- **Neo4j** — localhost:7687 (bolt), localhost:7474 (browser)
- **Redis** — localhost:6379
- **Kafka UI** — localhost:8080

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker addresses |
| `CHROMADB_URL` | `http://localhost:8000` | ChromaDB endpoint |
| `CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_PASSWORD` | `consumer123` | ClickHouse password |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j bolt URI |
| `NEO4J_PASSWORD` | `consumer123` | Neo4j password |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Model for skill generation + eval |
| `OUTPUT_DIR` | `./output` | Output directory for wiki/skills/evals |
