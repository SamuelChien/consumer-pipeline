# Consumer Pipeline

Pub/Sub consumer pipeline that reads analyzed chunks from `claude-sink` and writes to purpose-built data stores. Deploys to GKE cluster (`email-intelligence-cluster`).

## Architecture

```
┌──────────────────────────────────────┐
│ claude-sink (producer)               │
│                                      │
│ sink-skills-analyzed                 │
│ sink-sessions-analyzed               │
│ sink-code-analyzed                   │
└───────────────┬──────────────────────┘
                │
        ┌───────▼────────┐
        │ Google Pub/Sub │
        └───────┬────────┘
  ┌─────────────┼─────────────┐
  │             │             │
┌─▼──────┐ ┌───▼────┐ ┌──────▼──────┐
│ChromaDB│ │Click-  │ │ Wikipedia   │
│Consumer│ │House   │ │ Consumer    │
│        │ │Consumer│ │             │
│ Vector │ │        │ │ Articles +  │
│ chunks │ │Analytics│ │ keyword    │
│ for RAG│ │ tables │ │ linking     │
└────────┘ └────────┘ └─────────────┘
  │             │             │
┌─▼──────┐ ┌───▼────┐ ┌──────▼──────┐
│ Graph  │ │ Skill  │ │   Eval      │
│Consumer│ │Updater │ │ Consumer    │
│        │ │Consumer│ │             │
│ BM25 + │ │Generate│ │ Test cases  │
│PageRank│ │ new    │ │ + trigger   │
│ Neo4j  │ │ skills │ │ validation  │
└────────┘ └────────┘ └─────────────┘
```

## Consumers

| Consumer | Pub/Sub Topics | Output | Purpose |
|----------|---------------|--------|---------|
| **ChromaDB** | `sink-skills-analyzed`, `sink-sessions-analyzed` | ChromaDB collections | Vector chunks for RAG retrieval |
| **ClickHouse** | `sink-skills-analyzed`, `sink-sessions-analyzed` | ClickHouse tables + MVs | Analytics warehouse for skill maps, session metrics |
| **Wikipedia** | `sink-skills-analyzed`, `sink-sessions-analyzed` | Markdown in `output/wiki/` | Articles with `[[keyword]]` linking |
| **Graph** | `sink-skills-analyzed`, `sink-sessions-analyzed` | Neo4j graph | BM25 search + PageRank + similarity |
| **Skill Updater** | `sink-skills-analyzed`, `sink-sessions-analyzed` | SKILL.md in `output/generated-skills/` | AI-generated skills from gap analysis |
| **Eval** | `sink-skills-analyzed`, `sink-sessions-analyzed` | JSON in `output/evals/` | Test cases + trigger validation |

## Local Development

```bash
# Start data stores (ChromaDB, ClickHouse, Neo4j)
docker compose up -d

# Install and run all consumers
npm install
npm start
```

## Deploy to GKE

```bash
bash scripts/deploy.sh
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_ID` | `blobfish-ai-429200` | GCP project |
| `CHROMADB_URL` | `http://localhost:8100` | ChromaDB endpoint |
| `CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j bolt URI |
| `ANTHROPIC_API_KEY` | — | Required for skill-updater + eval |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Model for AI consumers |
