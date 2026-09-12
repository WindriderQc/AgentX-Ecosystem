# Task editing

Pipeline's **New task** button adds a task to the existing queue. **Edit task**
in a dossier opens the same form with its current content. A title is required;
the description is freeform Markdown, preserved without parsing historical
specifications. Service and priority are visible; **More details** holds dates,
dependencies, roadmap links and group. Dates use the browser's local time.

Saving an edit keeps the task's status, worker, heartbeat and execution receipts,
and adds a short feedback entry listing the changed fields. If another editor
saved first, the form keeps the draft and offers a comparison before retrying.
Closing a changed draft requires choosing whether to discard it.

**Help me write this** uses the configured local inference route. It proposes
a title, description, service and priority; **Use this draft** copies them into
the form. Only the normal save button persists a task. Editing, stopping or
closing cancels a pending proposal, and model errors leave manual editing
available. Existing descriptions over 24,000 characters use manual editing.

## HTTP contract

With a configured Coding Team runtime bridge, open a saved coding ticket and
choose **Give to the team**. The local planner either prepares a supported
repository scope for one worker run or puts a concrete question on the ticket.
**Reply and resume** stores the answer in the same discussion and preserves the
original attempt budget and patch. The worker stops at review or returns the
ticket blocked; accepting a result remains a human decision.

The board refreshes every ten seconds by default, including the open dossier.
Background refresh preserves form values, focus and scroll position. The latest
team question and next action precede technical details; the full audit remains
available below. Automatic refresh can still be switched off.

- `POST /api/pipeline/tasks` accepts `title`, `spec`, `service`, `priority`,
  `epic`, `dependsOn`, `dueAt`, `notBefore` and `planningItemIds`. An explicitly
  empty `spec` stays empty; existing objective/steps authoring remains supported.
  The editor uses the existing `source` + `sourceKey` retry identity.
- `GET /api/pipeline/tasks/:id` returns `data.task` and `data.editToken`.
- `PATCH /api/pipeline/tasks/:id` accepts `{ changes, editToken, by }`. `changes`
  contains only the content/planning fields listed above. The token describes
  those fields, so unrelated heartbeats or feedback do not invalidate a draft.
  A stale token returns `409 TASK_EDIT_CONFLICT`; fetch the latest task before
  retrying. Invalid fields, dependencies or new roadmap links return `400`.
- `POST /api/pipeline/draft` accepts `{ instruction, current }` and returns
  `data.draft` with `title`, `spec`, `service` and `priority`. It never writes
  tasks. The server chooses the configured model, propagates cancellation and
  limits the inference to 90 seconds. Invalid model output returns `502`.

Description storage allows 100,000 characters. New roadmap links must refer to
existing, nonarchived items; existing archived links remain intact on edits.
