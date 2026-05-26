# Consumer Pipeline

Unified Kafka consumer pipeline that reads from the sessions and skills producer topics and writes to purpose-built data stores. Deploys to the existing GKE cluster (`gke_blobfish-ai-429200_us-central1-a_email-intelligence-cluster`), sharing Kafka with the email-intelligence pipeline.

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
            │    ┌────────────────────┐    │
            └───►│ Kafka (GKE)       │◄───┘
                 │ kafka-service:9092 │
                 └────────┬──────────┘
      ┌──────────────────┬┴─────────────────┐
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

## Deploy to GKE

```bash
# Authenticate
gcloud container clusters get-credentials email-intelligence-cluster \
  --zone us-central1-a --project blobfish-ai-429200

# Build and push image
docker build -t gcr.io/blobfish-ai-429200/consumer-pipeline:latest .
docker push gcr.io/blobfish-ai-429200/consumer-pipeline:latest

# Deploy data stores
kubectl apply -f k8s/base/namespace.yaml
kubectl apply -f k8s/base/secrets.yaml
kubectl apply -f k8s/base/configmap.yaml
kubectl apply -f k8s/data-stores/

# Deploy consumers
kubectl apply -f k8s/base/consumers.yaml
```

## Local Development

```bash
# Start data stores (ChromaDB, ClickHouse, Neo4j, Redis) + local Kafka
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d

npm install
npm start
```

## Infrastructure

**GKE (production):**
- Kafka — `kafka-service.email-intelligence.svc.cluster.local:9092` (shared cluster)
- ChromaDB — `chromadb-service.consumer-pipeline:8000`
- ClickHouse — `clickhouse-service.consumer-pipeline:8123`
- Neo4j — `neo4j-service.consumer-pipeline:7687`

**Local dev:**
- Kafka — `localhost:9092` (via docker-compose.local.yml)
- ChromaDB — `localhost:8000`
- ClickHouse — `localhost:8123`
- Neo4j — `localhost:7687`

## Environment Variables

| Variable | Default (local) | GKE | Description |
|----------|----------------|-----|-------------|
| `KAFKA_ENV` | — | `gke` | Auto-detects in-cluster when set |
| `KAFKA_BROKERS` | `localhost:9092` | `kafka-service:9092` | Kafka bootstrap servers |
| `KAFKA_SSL` | `false` | `false` | Enable SSL for managed Kafka |
| `CHROMADB_URL` | `http://localhost:8000` | auto | ChromaDB endpoint |
| `CLICKHOUSE_URL` | `http://localhost:8123` | auto | ClickHouse HTTP endpoint |
| `NEO4J_URI` | `bolt://localhost:7687` | auto | Neo4j bolt URI |
| `ANTHROPIC_API_KEY` | — | secret | Required for skill-updater + eval consumers |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | same | Model for AI consumers |
