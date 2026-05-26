#!/bin/bash
set -euo pipefail

PROJECT_ID="blobfish-ai-429200"
REGION="us-central1"
ZONE="us-central1-a"
CLUSTER_NAME="email-intelligence-cluster"
IMAGE="gcr.io/${PROJECT_ID}/consumer-pipeline"
TAG="${1:-latest}"

echo "=== Consumer Pipeline Deploy ==="
echo "Project: ${PROJECT_ID}"
echo "Cluster: ${CLUSTER_NAME}"
echo "Image:   ${IMAGE}:${TAG}"
echo ""

# 1. Authenticate to GKE
echo "--- Authenticating to GKE ---"
gcloud container clusters get-credentials "${CLUSTER_NAME}" \
  --zone "${ZONE}" \
  --project "${PROJECT_ID}"

# 2. Build and push Docker image
echo "--- Building Docker image ---"
docker build -t "${IMAGE}:${TAG}" .

echo "--- Pushing to GCR ---"
docker push "${IMAGE}:${TAG}"

# 3. Deploy namespace and config
echo "--- Deploying base config ---"
kubectl apply -f k8s/base/namespace.yaml
kubectl apply -f k8s/base/configmap.yaml

# 4. Check if secrets exist, create if not
if ! kubectl get secret consumer-pipeline-secrets -n consumer-pipeline >/dev/null 2>&1; then
  echo "--- Creating secrets (EDIT k8s/base/secrets.yaml FIRST!) ---"
  kubectl apply -f k8s/base/secrets.yaml
else
  echo "--- Secrets already exist, skipping ---"
fi

# 5. Deploy data stores
echo "--- Deploying data stores ---"
kubectl apply -f k8s/data-stores/

echo "--- Waiting for data stores ---"
kubectl -n consumer-pipeline rollout status deployment/chromadb --timeout=120s || true
kubectl -n consumer-pipeline rollout status statefulset/clickhouse --timeout=120s || true
kubectl -n consumer-pipeline rollout status statefulset/neo4j --timeout=120s || true

# 6. Provision Kafka topics
echo "--- Provisioning Kafka topics ---"
kubectl -n consumer-pipeline run topic-provisioner \
  --image="${IMAGE}:${TAG}" \
  --restart=Never \
  --rm -it \
  --env="KAFKA_BROKERS=kafka-service.email-intelligence.svc.cluster.local:9092" \
  --command -- node scripts/provision-topics.js || true

# 7. Deploy consumers
echo "--- Deploying consumers ---"
kubectl apply -f k8s/base/consumers.yaml

# 8. Wait for rollout
echo "--- Waiting for consumer rollouts ---"
for consumer in chromadb clickhouse wikipedia graph skill-updater eval; do
  echo "  Waiting for ${consumer}-consumer..."
  kubectl -n consumer-pipeline rollout status "deployment/${consumer}-consumer" --timeout=120s || true
done

# 9. Status
echo ""
echo "=== Deployment Status ==="
kubectl -n consumer-pipeline get pods
echo ""
kubectl -n consumer-pipeline get svc
