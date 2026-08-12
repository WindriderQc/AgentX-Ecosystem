const mongoose = require('mongoose');

// Atomic sequence counters (e.g. pipeline task ids) — kills the race that let
// two agents grab the same id in the git-file era (the 0307 collision).
const CounterSchema = new mongoose.Schema({
  _id: String,                      // counter name, e.g. 'pipelineTask'
  seq: { type: Number, default: 0 },
});

// Atomically allocate the next value.
CounterSchema.statics.next = async function next(name) {
  const doc = await this.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return doc.seq;
};

// Ensure the counter is at least `min` (used after a roadmap import so new
// allocations continue past the highest imported id).
CounterSchema.statics.bumpTo = async function bumpTo(name, min) {
  await this.findByIdAndUpdate(name, { $max: { seq: Number(min) || 0 } }, { upsert: true });
};

module.exports = mongoose.model('Counter', CounterSchema);
