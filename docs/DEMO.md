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
4. Open **Set up a comparison**, choose the prepared host and two contenders.
   For a small first run, set all levels to **Off**, then choose **1 per
   category** for **L1 Basic**. In **Advanced settings**, set **Force num_ctx**
   to the context used for both models' throughput measurements, such as `8192`
   when both profiles measured at 8K. It must fit their current verified capacity
   and match their performance baseline; a smaller context alone is not enough.
   Automatic context recommendations require Full preparation. Review the model and
   test counts before starting.
5. Wait for generation and judging to finish. Open the results to compare
   responses, speed, and scores on the same prompts. Rule-based checks and
   judge scores are different kinds of evidence; missing scores are not zero.

The entry status refreshes when a comparison starts or finishes. Its history
count includes completed comparisons only. If status or history cannot be
checked, the page says so; use **Refresh** after the connection recovers.

This small run demonstrates the workflow, not a general model ranking. For
quality conclusions, use representative tasks, repeat the comparison, and
prefer a judge independent of the contenders.
