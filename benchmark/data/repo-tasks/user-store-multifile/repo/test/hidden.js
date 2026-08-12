const UserStore = require('../src/userStore');
const original = { name: ' Grace ', email: ' Grace@Example.Com ', role: 'admin' };
const store = new UserStore();
const added = store.add(original);
if (original.name !== ' Grace ' || original.email !== ' Grace@Example.Com ') process.exit(1);
if (added === original || added.role !== 'admin' || store.users.length !== 1) process.exit(1);
try { store.add({ name: 'G', email: ' GRACE@example.com ' }); process.exit(1); }
catch (error) { if (!/duplicate/i.test(error.message) || store.users.length !== 1) process.exit(1); }
process.exit(0);
