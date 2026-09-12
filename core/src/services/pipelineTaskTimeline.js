'use strict';

// Recorded timestamps only. updatedAt is never interpreted as a completion or
// stage transition, and free-form feedback is never parsed into invented events.
function taskTimeline(task) {
  const events = [];
  const add = (at, kind, label, attempt) => {
    const date = at ? new Date(at) : null;
    if (date && Number.isFinite(date.getTime())) {
      events.push({ at: date.toISOString(), kind, label, ...(attempt ? { attempt } : {}) });
    }
  };
  add(task.createdAt, 'created', 'Task record created');
  for (const attempt of task.automationAttempts || []) {
    add(attempt.acquiredAt, 'started', 'Attempt started', attempt.attempt);
    add(attempt.completedAt, 'completed', `Attempt ended: ${attempt.finalState || 'unknown'}`, attempt.attempt);
    if (['accepted', 'requeued', 'rejected'].includes(attempt.reviewOutcome)) {
      add(attempt.reviewedAt, 'reviewed', `Human decision: ${attempt.reviewOutcome}`, attempt.attempt);
    }
  }
  if (task.resolution?.kind === 'superseded') add(task.resolution.at, 'superseded', 'Closed by supersession');
  if (task.updatedAt && String(task.updatedAt) !== String(task.createdAt)) add(task.updatedAt, 'updated', 'Task record updated');
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

function taskSummaryWithTimeline(task) {
  const { automationAttempts, ...summary } = task;
  return { ...summary, timeline: taskTimeline(task) };
}

module.exports = { taskTimeline, taskSummaryWithTimeline };
