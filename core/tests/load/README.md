# Load Testing

Comprehensive load and stress tests for AgentX performance validation.

## Quick Start

```bash
# Run all tests
./tests/load/run-tests.sh

# Or run individual tests
npx artillery run tests/load/basic-load.yml
npx artillery run tests/load/stress-test.yml
```

## Test Suites

### 1. Basic Load Test (`basic-load.yml`)
**Duration:** 180 seconds
**Load Profile:**
- Warm-up: 5 req/sec (30s)
- Ramp-up: 10 req/sec (60s)
- Peak: 20 req/sec (60s)
- Cool-down: 5 req/sec (30s)

**Scenarios:**
- Health checks
- Metrics endpoints (cache, database, system)
- RAG search operations
- Conversation management
- Analytics queries
- Authentication flows

**Purpose:** Validate system stability under moderate, realistic load.

### 2. Stress Test (`stress-test.yml`)
**Duration:** 90 seconds
**Load Profile:**
- High load: 50 req/sec (60s)
- Peak load: 100 req/sec (30s)

**Scenarios:**
- Cache performance (40% weight)
- Database queries (30% weight)
- Metrics endpoints (20% weight)
- Mixed operations (10% weight)

**Purpose:** Identify breaking points and validate performance optimizations.

## Metrics Collected

### Request Metrics
- **Response times:** min, max, median, p95, p99
- **Request rate:** requests per second
- **Status codes:** 2xx, 4xx, 5xx distribution
- **Throughput:** bytes sent/received

### Custom Metrics
- **Search latency:** RAG search response times
- **Search buckets:** fast (<100ms), medium (<500ms), slow (>500ms)
- **Auth success rate:** login/logout operations

### System Metrics (via `/api/metrics`)
- **Cache hit rate:** embedding cache efficiency
- **Database connections:** pool usage
- **Memory usage:** Node.js heap and RSS
- **System uptime:** server stability

## Reports

Reports are saved to `tests/load/reports/` with timestamp:

```
tests/load/reports/
├── basic-load-20251205_143022.json
├── basic-load-20251205_143022.html
├── basic-load-20251205_143022.log
├── stress-test-20251205_143245.json
├── stress-test-20251205_143245.html
└── stress-test-20251205_143245.log
```

### HTML Reports
Open `.html` files in browser for interactive dashboards with:
- Response time charts
- Request rate graphs
- Status code distribution
- Percentile breakdowns
- Error analysis

## Performance Targets

### Expected Results (Post-Optimization)

| Metric | Target | Notes |
|--------|--------|-------|
| **p95 Response Time** | <200ms | Health, metrics endpoints |
| **p95 RAG Search** | <500ms | With cache hits |
| **p95 RAG Search** | <2s | With cache miss + embedding |
| **Cache Hit Rate** | >60% | After warm-up period |
| **Error Rate** | <1% | 4xx/5xx responses |
| **Throughput** | 50+ req/sec | Sustained load |

### Optimization Impact

**Before optimizations:**
- RAG search: ~3-5s (every request hits Ollama)
- Database queries: ~200-500ms
- Cache hit rate: 0%

**After optimizations:**
- RAG search: ~100-300ms (cache hit), ~2s (cache miss)
- Database queries: ~20-50ms (with indexes)
- Cache hit rate: 60-80%
- Connection pool: 30-50% improvement

## Interpreting Results

### Good Signs ✅
- p95 response times under targets
- Error rate <1%
- Cache hit rate improving over time
- Stable memory usage (no leaks)
- Connection pool usage <70%

### Warning Signs ⚠️
- p95 response times 2x target
- Error rate 1-5%
- Cache hit rate <40%
- Memory usage growing steadily
- Connection pool usage >80%

### Critical Issues 🚨
- p95 response times >5x target
- Error rate >5%
- Server crashes or OOM errors
- Connection pool exhaustion
- Database timeouts

## Troubleshooting

### High Response Times
```bash
# Check server logs
tail -f logs/app.log

# Check metrics dashboard
open http://localhost:3080/metrics.html

# Identify slow queries
grep "slow query" logs/app.log
```

### Memory Leaks
```bash
# Monitor memory during test
watch -n 1 'ps aux | grep node'

# Check heap usage
curl http://localhost:3080/api/metrics/system
```

### Connection Issues
```bash
# Check connection pool
curl http://localhost:3080/api/metrics/connection

# Check MongoDB logs
# (Atlas dashboard or local MongoDB logs)
```

## CI/CD Integration

Add to GitHub Actions or similar:

```yaml
- name: Load Testing
  run: |
    npm start &
    sleep 10
    ./tests/load/run-tests.sh
    kill %1

- name: Upload Reports
  uses: actions/upload-artifact@v3
  with:
    name: load-test-reports
    path: tests/load/reports/
```

## Advanced Usage

### Custom Scenarios

Edit YAML files to add new scenarios:

```yaml
- name: "Custom Scenario"
  weight: 5
  flow:
    - post:
        url: "/api/custom-endpoint"
        json:
          param: "value"
```

### Environment Variables

```bash
# Test against different environment
TARGET_URL=http://staging.example.com:3080 \
npx artillery run tests/load/basic-load.yml
```

### Plugins

Artillery supports plugins for:
- AWS CloudWatch metrics
- Datadog integration
- Slack notifications
- Custom reporters

Install via: `npm install --save-dev artillery-plugin-<name>`

## Resources

- [Artillery Documentation](https://www.artillery.io/docs)
- [Performance Testing Best Practices](https://www.artillery.io/docs/guides/overview/performance-testing-best-practices)
- [AgentX Metrics Dashboard](http://localhost:3080/metrics.html)

## Next Steps

1. **Baseline:** Run tests and save results as baseline
2. **Compare:** Run tests after changes to measure impact
3. **Optimize:** Use results to identify bottlenecks
4. **Monitor:** Set up continuous load testing in CI/CD
