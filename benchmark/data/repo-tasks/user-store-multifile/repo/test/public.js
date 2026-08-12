const UserStore = require('../src/userStore');
const store = new UserStore();
const added = store.add({ name: ' Ada ', email: ' ADA@EXAMPLE.COM ' });
if (added.name !== 'Ada' || added.email !== 'ada@example.com') process.exit(1);
try { store.add({ name: 'Other', email: 'ada@example.com' }); process.exit(1); }
catch (error) { if (!/duplicate/i.test(error.message)) process.exit(1); }
process.exit(0);
