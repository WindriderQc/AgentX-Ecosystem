# Paired final-only vs thinking campaigns

Use `benchmark/scripts/paired-thinking-campaign.js` to compare one exact local
model in `final_only` and `explicit_thinking` modes. The runner freezes the
candidate, judge, prompt IDs, context, output budget, sampling settings, seed,
and repeat count. It launches the two modes as separate sequential batches so
their evidence cohorts cannot be silently mixed.

The command is a dry plan unless `--execute` is present. Live runs require the
Benchmark singleton to be free and accept an operator token only through the
named environment variable; the token is never written to the plan or report.
After each batch reaches terminal row counts, the runner also waits for the
persisted singleton slot to become idle. This covers the bounded pin-restore
window without racing the next mode.

```powershell
npm run campaign:paired-thinking -- `
  --host http://candidate:11434 `
  --model exact-model-tag `
  --judge-host http://judge:11434 `
  --judge-model exact-judge-tag `
  --prompt-ids id1,id2,id3 `
  --repeats 3

npm run campaign:paired-thinking -- --execute <the same frozen arguments>
```

If the process stops after a completed final-only half, resume it without
spending those rows again:

```powershell
npm run campaign:paired-thinking -- --execute `
  --resume-final-only-batch <exact-batch-object-id> `
  <the same frozen arguments>
```

Resume is fail-closed: the completed batch must match the exact host, model,
judge, prompt order, repeats, context, output budget, sampling settings, seed,
and final-only response mode. The original full pair ID is recovered from the
batch description and reused for the thinking half.

The report has three deliberately separate views:

- `raw` includes numeric scores even when the row is provisional.
- `review_clean` excludes infrastructure failures, `needs_review`, and every
  row excluded from the leaderboard.
- `paired_comparison` includes a prompt only when both modes have the required
  number of clean repeats; everything else is listed under `unresolved`.

The comparison is also withheld unless both modes report exactly one identical
candidate artifact digest. A mutable tag that changes between modes therefore
cannot produce a quality or latency delta.

Reports are always `exploratory`, never authorize a routing change, and never
claim qualification. A code prompt whose `evaluation_authority` is
`executable` must be run through `repo-coding-qualification.js` in both modes;
its ordinary LLM-judge row is advisory and is excluded from numeric ranking.
