#!/usr/bin/env bash
BASE="${BASE_URL:-http://localhost:3080}"

echo "=== Testing Analyze Failures Endpoint ==="

echo ""
echo "1. Valid request with version 1..."
curl -s -X POST "$BASE/api/prompts/default_chat/analyze-failures" \
  -H "Content-Type: application/json" \
  -d '{"version":1,"limit":20}' \
  | jq '.status, .data.conversations, .data.llmAnalysis'

echo ""
echo "2. Missing version (should use active version)..."
curl -s -X POST "$BASE/api/prompts/default_chat/analyze-failures" \
  -H "Content-Type: application/json" \
  -d '{"limit":5}' \
  | jq '.status, .data.prompt.version'

echo ""
echo "3. Invalid prompt name (should error)..."
curl -s -X POST "$BASE/api/prompts/nonexistent/analyze-failures" \
  -H "Content-Type: application/json" \
  -d '{"version":1}' \
  | jq '.status, .message'

echo ""
echo "4. Large limit (stress test)..."
curl -s -X POST "$BASE/api/prompts/default_chat/analyze-failures" \
  -H "Content-Type: application/json" \
  -d '{"version":1,"limit":100}' \
  | jq '.data.conversations'

echo ""
echo "=== Tests Complete ==="
