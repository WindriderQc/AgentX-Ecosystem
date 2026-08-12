# Guided Agent X demos

## Demo 1 — route a local answer

1. Start the stack and open <http://localhost:3180/>.
2. Open **Playground**.
3. After explicitly installing or pulling a chat model, select it and ask a
   short question.
4. Open **Models** or **Analytics** and show the model, endpoint boundary, and
   recorded inference evidence.

Without Ollama or a model, the UI still loads and honestly reports that
inference is unavailable.

## Demo 2 — ground and compare

1. Open **Ingest a document** and upload a small, non-sensitive text document.
2. Search for a fact that occurs only in that document and inspect the
   retrieved passage.
3. Open **Compare models** or the leaderboard.
4. Explain how RAG evidence and Benchmark results can inform a routing choice
   before it is promoted.

OpenClaw, Hermès Agent, OctoPrint, personal data, and AIOps operational
surfaces are intentionally absent from both demos.
