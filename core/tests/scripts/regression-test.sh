#!/usr/bin/env bash
BASE="${BASE_URL:-http://localhost:3080}"

echo "=== AgentX Phase 3 Regression Test Suite ==="

echo ""
echo "1. Health Checks..."
curl -s "$BASE/health" | jq '.status'
curl -s "$BASE/api/conversations" | jq '.status'

echo ""
echo "2. Core Chat (ensure not broken)..."
curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5:7b","message":"Hello"}' \
  | jq '.status'

echo ""
echo "3. RAG functionality..."
curl -s -X POST "$BASE/api/rag/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","topK":5}' \
  | jq '.status'

echo ""
echo "4. Prompt Management..."
curl -s "$BASE/api/prompts" | jq '.status'
curl -s "$BASE/api/prompts/default_chat" | jq '.status'

echo ""
echo "5. Analytics..."
curl -s "$BASE/api/analytics/usage" | jq '.status'
curl -s "$BASE/api/analytics/feedback/summary?sinceDays=7" | jq '.status'

echo ""
echo "6. Phase 3 New Endpoints..."
curl -s -X POST "$BASE/api/prompts/default_chat/analyze-failures" \
  -H "Content-Type: application/json" \
  -d '{"version":1,"limit":5}' \
  | jq '.status'

echo ""
echo "=== Regression Tests Complete ==="
