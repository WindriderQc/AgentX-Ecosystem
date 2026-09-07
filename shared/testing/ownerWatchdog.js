'use strict';
// Windows can terminate the launcher without delivering a catchable signal.
// Jest and its workers must not outlive that owner. MongoMemoryServer's own
// parent-death cleanup and Core's daemon watchdog then reap their instances.
const owner = Number(process.env.TEST_RUN_OWNER_PID);
if (Number.isInteger(owner) && owner > 0) {
  setInterval(() => {
    try { process.kill(owner, 0); }
    catch (err) {
      if (err.code === 'ESRCH') process.exit(1);
    }
  }, 500).unref();
}
