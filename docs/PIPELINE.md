# Work in progress (Pipeline)

Pipeline follows the product task queue in the full profile. The status cards
retain all-time counts, including done. The count caption states the exact API
scope and whether the loaded rows are complete (at most 1,000).

## Follow related work

Select a status card to focus the progression immediately below it and the
detailed work queue. Select it again to release that filter. Search, service,
lane/source, group/epic and sort controls sit beside the progression. Filters
remain selected during refresh; the global counts retain their stated scope.
An Agent Ops handoff can additionally bound the task, owner or status.

The board groups tasks by their current status. Each card opens the existing
dossier. Completed tasks appear in the Done column, newest updated first;
each column initially shows at most eight cards and offers **Show all**. On
small screens the board scrolls horizontally. **Include done** affects the
board and timeline; the detailed queue shows open work unless a status card
explicitly selects done.

Choose a **Task group / epic** to follow related tasks through completion.
**Timeline** orders recorded creation, update, attempt and human-decision
timestamps, newest first. Its status badges describe the current task status.
Record updates are not completion events. Missing transitions remain unknown;
free-form feedback is available in the dossier, not interpreted as dates.
Superseded tasks are identified as closed by replacement, not delivered.

## Prepare, launch and decide

**Prepare and launch** retains the detailed queue, task creation and **Run one
task**. Select a candidate and confirm the existing one-shot run. The runtime
still revalidates eligibility, scope, dependencies and budgets. This action
starts one attempt; it does not merge or deploy.

New task and Edit task retain manual authoring, dates, dependencies, roadmap
links and optional writing assistance. A generated draft is a proposal until
explicitly applied and saved. Concurrent edits show a comparison before saving.

**Follow and decide** places Needs attention beside active delivery evidence.
The dossier retains specification, metadata, feedback, attempt receipts,
acceptance, correction, requeue and supersession operations. A closed unmerged
PR retains its existing reopen-through-correction path. General task reopening
remains available through the unchanged status API. A delivery
can show its PR, exact CI, receipt checks, merge action and production evidence.
Existing lifecycle and exact-identity checks remain authoritative.

Task, performance, dispatch and delivery reads load independently. Each read
has a deadline; replaced requests cannot overwrite newer results. A failed task
refresh retains the previous observation with an error. Delivery failures retain
previous evidence with a stale label and disable merge controls. Delivery panels
reserve their own scrollable space so late evidence does not move other work.

## Read history and performance

Coding Team metrics and recent attempts share the selected 7, 30 or 90 day
window. The population is **attempts started during that period across all
tasks**, independently of the board filters or selected launch. The displayed
dates and denominators make that scope explicit; the attempt table shows at
most 50 of the measured attempts.

- Accepted: human-accepted attempts among decided attempts.
- First pass: accepted first attempts among all accepted attempts.
- Cycle: task creation to human decision, only where both dates are observed.
- Corrections: recorded requeues and rejections.
- Cost/evidence: provider spend, unverified session estimates, measured local
  GPU energy and electricity estimates retain separate provenance and coverage.

Recently done retains eight closed records ordered by last update. Completed
production deliveries remain available as expandable records with their full
proof and expert links. Their population is the delivery observation, separate
from the attempt window. Task closure, attempt acceptance, merge, deployment
and live production proof remain distinct.

## Capability preservation map

| Existing capability | Current location / verification |
|---|---|
| Global status counts, done and count evidence | Status cards; summary route and rendered filter checks |
| Search, service, source, urgency/priority/recent/id sort, clear | Overview toolbar; board and detailed queue |
| Agent Ops context, task deep links | Context banner and dossier; handoff contract tests |
| Create/edit, optional draft/apply/cancel, conflict comparison | Existing editor; Mongo editor/authoring and draft tests |
| Dates, dependencies, roadmap links, owner/status preservation | More details and dossier; editor/eligibility tests |
| Dossier, specification, feedback and attempt evidence | Every task card, list row and attempt; rendered desktop/mobile |
| Accept, correction, requeue and supersede preview/confirm | Existing dossier actions; lifecycle and supersession tests |
| Reopen after closed unmerged PR; general task reopening | Existing correction path; unchanged status API and lifecycle tests |
| Needs attention, stale heartbeat, overdue/dependency issues | Follow and decide; existing attention projection |
| Eligible one-shot launch and explicit confirmation | Prepare and launch; existing runtime dispatch contracts |
| Performance windows, attempts, quality, cycle, corrections | History and performance; aggregation tests and rendered scope |
| Cost, energy, currency, coverage and missing evidence | History metrics and attempt dossier; evidence tests |
| PR/CI/receipt/merge/deploy/production evidence and actions | Active deliveries and expandable completed deliveries |
| Refresh, auto-refresh, guide, keyboard dossier access | Page controls; rendered refresh, error and mobile checks |

No lifecycle operation is performed by dragging or moving a board card.
