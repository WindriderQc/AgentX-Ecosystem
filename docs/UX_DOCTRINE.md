# Agent X UX doctrine

Status: canonical product UX doctrine.

## Product promise

Agent X welcomes people without asking them to understand its architecture,
then reveals the full machine in the context of the task when they choose to
take control.

There is one product and one task context. Simple and expert depth are
presentation states, never deployment profiles, permission levels, or alternate
implementations. Opening advanced controls must not navigate away, discard
input, reset scroll, or change the active conversation.

## Experience contract

The default depth answers four questions in this order:

1. What can I do now?
2. What is the primary action?
3. Is Agent X ready for that action?
4. Where can I take control?

The expert depth may then expose route, host, model, context, retrieval,
thinking, web search, telemetry, evidence, alerts, and diagnostics. It should
feel like a calm cockpit opened around the current task, not a separate
configuration application.

Runtime profile guards remain authoritative. Expert depth reveals only the
capabilities allowed by the current profile and never unlocks a blocked route.

## Information architecture

Use plain action language first and product terminology second. Preserve stable
URLs and API contracts when labels change.

| Primary label | Technical precision | Destination |
|---|---|---|
| Chat | Playground | `/playground` |
| Knowledge | RAG workspace | RAG service |
| Add knowledge | Document ingestion | `/upload` on the RAG service |
| Ask your knowledge | Semantic retrieval | `/search` on the RAG service |
| Your sources | Corpus browser | `/documents` on the RAG service |
| Compare models | Benchmark | Benchmark service |
| Work in progress | Pipeline | `/pipeline` |
| System status | Nerve Center | `/nerve-center` |
| Models | Runtime and model registry | `/models` |
| Activity | Analytics and observability workbench | `/analytics` |
| Take the controls | Routing and execution controls | Contextual drawer |

The product UI remains English until an explicit localization initiative adds a
complete locale. Do not mix French and English labels in one surface.

## Visual grammar

Visuals must help the user understand, decide, or act. Prefer hierarchy,
spacing, action cards, direct previews, and progressive panels over additional
paragraphs, tours, or decorative dashboards.

| Meaning | Color role | Required non-color cue | Typical action |
|---|---|---|---|
| Ready | green | check icon and `Ready` | continue |
| Attention | amber | warning icon and a suggested next step | review |
| Blocked | red | stop icon and explicit cause | intervene |
| Unknown | neutral gray | question icon and `Not observed` | refresh or inspect |
| Active control | cyan | control/sliders icon and label | take or release control |

Never communicate state by color alone. Status components include a symbol,
human label, and concise consequence. Technical evidence belongs beside or
behind the status, not in place of it.

Use a single consistent visual door labelled `Take the controls`. Opening it:

- keeps the task and composer stable;
- moves focus into the drawer and returns focus to the opener when closed;
- exposes a compact summary before detailed instruments;
- supports Escape, keyboard navigation, and visible focus;
- respects `prefers-reduced-motion`.

Avoid ambiguous icon-only controls, badge accumulation, graphs without a
decision, and cockpit decoration without operational meaning.

## Density rules

Simple depth uses one dominant action, short labels, generous spacing, and no
required acronym. It may show one human system status and one compact choice
such as response depth.

Expert depth may be denser, but groups controls by decision:

1. response strategy;
2. knowledge and tools;
3. manual runtime selection;
4. tuning and limits;
5. evidence and diagnostics.

Manual host and model controls appear only when manual routing is selected.
Diagnostics use disclosure sections rather than competing with task controls.

## First vertical slice wireframes

### Simple home

```text
Agent X                                           Ready  ✓

What do you want to do?
Start with a conversation. Agent X chooses the route for you.

[ Start a conversation  → ]  [ Use your documents ]  [ Compare models ]

How Agent X works  ▾
```

### Simple chat

```text
Agent X · Home        Ready to chat  ✓        Balanced · automatic
                                             [ Take the controls ]

Quick chat
Ask anything. Agent X will choose a suitable route for this conversation.

[ Summarize something ] [ Brainstorm ] [ Explain a concept ]

┌ Message Agent X…                                              Send ┐
```

### Expert chat

```text
Conversation remains visible                 ┌ Take the controls ────┐
and the composer remains stable.              │ Balanced · automatic  │
                                               │                       │
                                               │ Response strategy     │
                                               │ Knowledge and tools   │
                                               │ Manual route          │
                                               │ Tuning and limits     │
                                               │ Evidence              │
                                               └───────────────────────┘
```

### Degraded chat

```text
AI model not ready  !
Agent X is running, but no chat model is currently available.

[ Set up a model ]  [ Refresh status ]

Your documents and saved evaluation results remain available when their
services are healthy.
```

## Knowledge vertical slice

Knowledge follows one visible, stable journey: `Add knowledge` → `Ask your
knowledge` → `Browse sources`. Readiness and maintenance are instruments, not
mandatory steps. They stay available through `Open instruments` without
crowding the primary journey.

### Knowledge home

```text
Agent X Knowledge                         ✓ Ready for your first source

Ground Agent X in what matters to you.

[ Add knowledge → ]  [ Ask your knowledge → ]  [ Browse sources → ]

Your knowledge is empty
Add one useful source, then ask Agent X to find evidence in it.
[ Add knowledge ]

[ Take the controls · Expert                                      ▾ ]
```

### Add knowledge

```text
Add knowledge
[ Paste text ] [ Choose a file ]

┌ Document text…                                                   ┐
└──────────────────────────────────────────────────────────────────┘

[ Take the controls · source, tags, document ID, chunking        ▾ ]
[ Add to Agent X ]
```

### Ask your knowledge

```text
Ask your knowledge                          ✓ 3 sources available

┌ What do you want to find?                                      ┐
└─────────────────────────────────────────────────────────────────┘
[ Key decisions ] [ Risks and limits ] [ Strongest evidence ]

[ Take the controls · ranking, filters, enhancements             ▾ ]
[ Find evidence ]

Evidence 1                         ✓ Strong match · 87%
Supporting passage…                                  [ Open source → ]
```

Retrieval scores always include a semantic label (`Strong match`, `Possible
match`, or `Weak match`) and icon. Exact percentages support expert comparison
but never carry meaning alone. When no source exists, search is disabled and
the status points directly to `Add knowledge`. Source labels, tags, document
IDs, chunking, ranking, filters, and retrieval enhancements remain available
inside the contextual cockpit.

## Model evidence vertical slice

Evaluation follows the decision `Compare models` → `See ranked models` →
`Inspect evidence`. A benchmark is not the default page structure: it is one
action the user starts after Agent X has explained whether the runtime and its
performance baseline are ready.

### Compare models

```text
Find the best model for the job.          ! Host needs a quick profile
                                           7 models online · baseline required

[ Prepare the host → ] [ See ranked models → ] [ Inspect evidence → ]

[ Take the controls · host, models, judge, depth, live diagnostics       ▾ ]
```

The simple surface never claims a runtime is offline when its live state is
unknown. `Unknown` remains a neutral, refreshable state. `Offline` is reserved
for a completed live check that found no available runtime. The expert host
picker reconciles stored profiler metadata with a fresh runtime probe before
labelling availability.

The evaluation cockpit preserves all execution, contender, judge, prompt-depth,
preflight, launch, progress, anomaly and event-log controls. While closed, its
surface is both visually hidden and inert so it cannot leak controls into the
keyboard order or accessibility tree.

### Empty evidence

```text
Inspect the evidence

No evaluation evidence yet
Run a focused comparison first. Every prompt, response, score and runtime
signal will become inspectable here.

[ Run a comparison ] [ Prepare a host ]
```

Rankings and evidence views do not render zero-value dashboards, empty charts,
advanced filters or scoring instruments before evidence exists. They show one
actionable empty state; the complete analytical workbench becomes visible and
accessible only when results exist.

## Models, preparation, and activity slice

The default model decision is automatic routing. The model catalog is not a
prerequisite for chat; it is the place to make an exact choice, inspect an
artifact, manage a source, or override execution intentionally.

```text
Choose a model—or let Agent X choose.          ✓ 7 models ready

[ Chat automatically → ] [ Browse installed models → ] [ Compare → ]

[ Take the controls · registry, hosts, filters, overrides             ▾ ]
```

Exact-model chat links preserve the selected model when moving to `/playground`.
The demo profile does not probe operator-only cluster scheduling endpoints to
decorate the model catalog. Closed drawers and modals remain visually hidden,
inert, and absent from the accessibility tree.

Profiler is a guided prerequisite flow, not an automatic benchmark action:

```text
Prepare trustworthy model comparisons.        ! Host baseline required

[ Prepare the host → ] [ Profile exact models → ] [ Compare prepared → ]

[ Take the controls · probes, queues, depth, fit reports              ▾ ]
```

Opening `Prepare the host` reveals and focuses the baseline controls; it never
starts a hardware probe without the user's explicit launch action. Live runtime
availability, stored host baselines, and exact-artifact profiles remain distinct
facts.

The demo label `Activity` maps to the stable `/analytics` route. Its simple
surface reports recent inference reliability, conversation activity, and
knowledge use. The full models/callers/latency/outcomes/cost/RAG workbench stays
behind `Take the controls`. Telemetry routes excluded by the demo profile are
not called and do not appear as product failures.

## Verification contract

Every changed primary surface is checked at 360, 768, and 1440 CSS pixels,
at 200% zoom, with keyboard-only navigation, visible focus, reduced motion,
and normal, degraded, loading, empty, and error states where applicable.

Automated tests protect semantic labels, disclosure state, stable routes, and
the presence of an actionable degraded state. Browser verification confirms
layout, focus, preserved input/context, console errors, and real responsive
behavior.

## Evolution rule

Extend these primitives one vertical slice at a time. Do not start a parallel
design-system rewrite. Each slice must preserve existing capability contracts,
add the smallest reusable visual primitives it needs, and leave the product in
a coherent state.
