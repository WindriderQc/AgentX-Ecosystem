#!/bin/bash
# Manual test script for cost analytics endpoints
# Run this after starting the server with: npm start

BASE_URL="http://localhost:3080"

echo "=========================================="
echo "Testing Cost Analytics Endpoints"
echo "=========================================="
echo ""

echo "1. Testing GET /api/analytics/stats (should include cost data)"
curl -s "${BASE_URL}/api/analytics/stats" | jq -C '.' | head -50
echo ""
echo ""

echo "2. Testing GET /api/analytics/usage?groupBy=model (should include cost breakdown)"
curl -s "${BASE_URL}/api/analytics/usage?groupBy=model" | jq -C '.'
echo ""
echo ""

echo "3. Testing GET /api/analytics/costs (new endpoint)"
curl -s "${BASE_URL}/api/analytics/costs" | jq -C '.'
echo ""
echo ""

echo "4. Testing GET /api/analytics/costs?groupBy=day"
curl -s "${BASE_URL}/api/analytics/costs?groupBy=day" | jq -C '.'
echo ""
echo ""

echo "5. Testing GET /api/analytics/costs?groupBy=promptVersion"
curl -s "${BASE_URL}/api/analytics/costs?groupBy=promptVersion" | jq -C '.'
echo ""
echo ""

echo "=========================================="
echo "All tests completed!"
echo "=========================================="
