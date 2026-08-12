#!/usr/bin/env bash
BASE="${BASE_URL:-http://localhost:3080}"

echo "=== Testing Rate Limiting ==="

echo ""
echo "1. Testing general API rate limit..."
for i in {1..105}; do
  code=$(curl -s "$BASE/api/conversations" -w "%{http_code}" -o /dev/null)
  echo "Request $i -> $code"
  if [ "$i" -eq 100 ]; then echo ">>> Request 100 (should still work)"; fi
  if [ "$i" -eq 101 ]; then echo ">>> Request 101 (should fail with 429)"; fi
done

echo ""
echo "2. Testing chat rate limit (20/min)..."
for i in {1..25}; do
  code=$(curl -s -X POST "$BASE/api/chat" \
    -H "Content-Type: application/json" \
    -d '{"model":"qwen2.5:7b","message":"Test"}' \
    -w "%{http_code}" -o /dev/null)
  echo "Request $i -> $code"
  if [ "$i" -eq 20 ]; then echo ">>> Request 20 (should still work)"; fi
  if [ "$i" -eq 21 ]; then echo ">>> Request 21 (should fail with 429)"; fi
done

echo ""
echo "3. Testing strict rate limit on expensive operations..."
for i in {1..15}; do
  code=$(curl -s -X POST "$BASE/api/prompts/default_chat/analyze-failures" \
    -H "Content-Type: application/json" \
    -d '{"version":1}' \
    -w "%{http_code}" -o /dev/null)
  echo "Request $i -> $code"
  if [ "$i" -eq 10 ]; then echo ">>> Request 10 (should still work)"; fi
  if [ "$i" -eq 11 ]; then echo ">>> Request 11 (should fail with 429)"; fi
done

echo ""
echo "4. Checking rate limit headers..."
curl -i "$BASE/api/conversations" | rg -i "ratelimit"

echo ""
echo "=== Tests Complete ==="
