# Guided Agent X demos

Start with `agentx.ps1 up` on Windows or `./agentx up` on Linux, then run the
matching `health` command. The root page and service navigation work without
Ollama; inference workflows require models chosen by the tester.

## Demo 1 — route a local answer

1. Start the stack and open <http://127.0.0.1:3180/>.
2. Open **Chat**.
3. After explicitly installing or pulling a chat model, ask a short question.
   Agent X routes automatically; open **Take the controls** only to demonstrate
   an exact model choice.
4. Open **Models** or **Activity** and show the model, endpoint boundary, and
   recorded inference evidence.

Without Ollama or a model, the UI still loads and honestly reports that
inference is unavailable.

Open **Conversations** and use a row's **More actions** menu to rename or delete
that conversation. Rename changes its title without changing messages. Delete
asks for confirmation and removes only the selected conversation. If the server
rejects either action, the page reports the failure and keeps the current chat.

**Stop** immediately stops showing new text and saves the partial answer.
An already dispatched Ollama request can keep running in the background until
it finishes. Agent X retains its runtime reservation until that completion;
switching models may need to wait. Stop does not promise immediate GPU release.

## Demo 2 — compare a persona on the same model

1. Open <http://127.0.0.1:3180/playground?persona=learning_guide>.
2. Open the configuration drawer and confirm **System Prompt** is
   `learning_guide v1`. The adjacent details button shows the active prompt.
3. Keep the host, model, routing mode, and question fixed. Ask one explanation
   with **Learning Guide**, then select `default_chat` and ask it again.
4. Compare the structure and check-for-understanding behavior while inspecting
   the same model and host receipt after each answer.

`learning_guide` is an idempotently seeded, generic chat persona. It downloads
no model, grants no tools, and contains no private identity or environment
details. The exercise isolates prompt behavior from model and routing changes.

## Demo 3 — ground and compare

1. Open **Add knowledge** and upload or paste a small, non-sensitive text source.
2. Open **Ask your knowledge**, search for a fact that occurs only in that
   source, and inspect the
   retrieved passage.
3. Open **Compare models** or the leaderboard.
4. Explain how RAG evidence and Benchmark results can inform a routing choice
   before it is promoted.

This workflow also needs the configured embedding model. Environment-specific
operations, private data, and external adapters are intentionally absent from
all three demos.

For a repeatable first try, paste this fictional note:

```text
The Cedar project launches on October 12. Maya owns the launch checklist.
The team reviews open issues every Tuesday at 10:00.
```

Search for **Who owns the Cedar launch checklist?** The matching passage
should contain Maya's name. Choose **Open exact source** to inspect the indexed
document and its passages. Search returns supporting passages, rather than a
generated conversational answer.

If a dependency is unavailable, you can write your question and set filters
while fixing it. Select **Check again** on the search page to refresh readiness
without leaving or losing that input. In **Indexed documents**, use **Load more
documents** to continue beyond the first 200; active source and tag filters
stay applied.

## Demo 4 — complete a model comparison

1. Open **Compare models**, then **Prepare the host**. Choose an installed
   baseline model and run **Baseline Probe**.
2. Use **Profile exact models** to run a **Standard** profile for two installed
   chat models. Wait for both to finish and check that they are qualified.
   Long-context probes can take several
   minutes, especially when a model exceeds GPU memory.
3. Return to **Compare models**. If prompted, choose an installed judge in
   setup and save it.
4. Open **Set up a comparison**, choose the prepared host, two local contenders,
   and an installed judge. Select **Apply quick preset**. It checks both models
   through the same inference contract used at launch and chooses a common
   context of at most 8,192 tokens, bounded by their qualified measurements.
   It selects one **L1 Basic** prompt per category, limits each response to 512
   tokens, and turns thinking off for a controlled visible-answer comparison.
   It resets advanced execution/judge settings and uses one judge and one
   repeat. Review the summary and test count, then launch.
5. Wait for generation and judging to finish. Open **Results**, use the Prompt
   column to find matching tasks, and select 2–4 results on the current page.
   **Compare responses** shows the prompts and answers alongside response time,
   speed, and quality. Identical recorded prompts appear once above the answers;
   different or missing prompts remain visible with each answer. The view shows
   the selected sample size and points out different runs or scoring sources.
   Rule-based checks, judge scores, and human overrides are labeled separately;
   missing scores are not zero, and excluded results stay identified.
   Open **Scoring and run details** for the recorded settings,
   judge, composite score, and date. These individual responses support inspection;
   use repeated representative tasks before drawing a broader ranking.

The entry status refreshes when a comparison starts or finishes. Its history
count includes completed comparisons only. If status or history cannot be
checked, the page says so; use **Refresh** after the connection recovers.

If either model needs preparation or the shared context is not verified, Quick
comparison explains the problem before applying settings. Both models' response
times and speed are measured during the comparison itself. Historical profiler
speed is used as a reference only when it was measured at the exact execution
context. Quick comparison does not change model defaults or replace the normal
launch checks. Full preparation is still required for automatic context
recommendations elsewhere.

Changing the models, judge, or settings invalidates the Quick comparison preview;
apply it again for the new selection. **Customize test depth** and **Advanced
settings** support larger or custom runs. An independent judge keeps its own
context policy; a judge that is also a contender uses that model's measured
context and shows a reminder about judging its own answers.

This small run demonstrates the workflow, not a general model ranking. For
quality conclusions, use representative tasks, repeat the comparison, and
prefer a judge independent of the contenders.
