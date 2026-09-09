# Benchmark context and output budgets

Difficulty levels L1–L5 describe reasoning difficulty, not a required context
size. A short L5 question can need less input space than a long L1 extraction.
The configuration form shows each level's eligible catalog count, maximum
prompt characters and declared expected answer range. Sampling can select a
shorter prompt. Character counts exclude wrappers and custom hints; expected
answer lengths are author metadata, not measured requirements for success.

The execution context must fit input, reasoning and final output. The response
token limit is separate: it caps reasoning and the final answer together. A
response can stop at that limit with context still available. Increasing
context alone does not fix an output cap. Leave context overrides blank to
retain the runtime/profile setting, or set them explicitly for a controlled
comparison. Warnings do not silently rewrite the chosen settings.

Judge calls also need room for the task, evaluated answer, reference, rubric
and verdict. Scorer 2.9.0 preserves complete reference and decomposed judge
inputs by default. An explicit `response_char_budget` still requests an excerpt;
every reference check uses that same excerpt and reports
`response_truncated_for_judge`, `response_chars` and `judge_window_chars`.
Reported upstream truncation or condensation invalidates the judge call.
Estimated overflow is still report-only: it is not proof that the runtime
truncated input, and an unreported upstream truncation cannot be ruled out by
these fields. Core's inference contract retains its budget estimate and warnings.

Use result evidence to tune the next run: measured `prompt_eval_count`, output
token count and length-stop reason, requested context, thinking policy and
judge reliability. Verify residency/VRAM on the selected host independently;
loading a larger model does not establish its accuracy as a judge. Keep old
results and their scorer versions intact; rerun selected cases explicitly when
comparing changed scoring behavior.

When warmup requests unloading other models, it now applies that policy even
if the target judge is already resident. The target, embedding models and
explicitly retained models remain loaded. Benchmark's existing claim and pin
restoration lifecycle controls the temporary residency change.
