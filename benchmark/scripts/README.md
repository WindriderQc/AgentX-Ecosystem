# Benchmark Scripts

## `migrate-modelprofile-category-metadata.js`

Backfills benchmark-owned `modelprofiles` with legacy `categories` and `benchmarkStats.bestCategory` from core-owned `modelregistries`.

Safety rules:

- reads `modelregistries` only
- writes only `modelprofiles`
- only migrates models benchmark already knows about through existing `modelprofiles` rows or `benchmarkresults`
- sets only `categories` and `benchmarkStats.bestCategory`
- safe to rerun; once the metadata matches, the script plans zero further changes

Audit / rerun commands:

```bash
node scripts/migrate-modelprofile-category-metadata.js --dry-run
node scripts/migrate-modelprofile-category-metadata.js
curl -s http://localhost:3081/api/benchmark/dashboard \
  | jq '.data.model_stats[] | select(.manual_categories | length > 0) | {model, manual_categories, recommended_category}'
```

## `migrate-tokens-per-sec-to-number.js`

One-off backfill (TODO 0233) that converts legacy `BenchmarkResult.tokens_per_sec`
string rows to `Number`. The schema now stores the field as a number and the
aggregation pipelines no longer wrap it in `$toDouble`, so any pre-existing
string rows must be coerced for the cast-free `$avg`/`$stdDevPop` to work.

Safety rules:

- reads and writes only the benchmark-owned `benchmarkresults` collection
- updates only documents where `tokens_per_sec` is a BSON string (type 2)
- already-numeric rows are left untouched
- idempotent; re-running after a clean pass converts nothing
- unparseable strings are coerced to 0 (matches the schema setter)
- operator-run only; do NOT wire into CI

Audit / run commands:

```bash
node scripts/migrate-tokens-per-sec-to-number.js --dry-run
node scripts/migrate-tokens-per-sec-to-number.js
```
