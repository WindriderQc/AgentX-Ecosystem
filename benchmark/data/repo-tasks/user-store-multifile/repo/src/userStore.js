const normalizeUser = require('./normalizeUser');

class UserStore {
  constructor() { this.users = []; }
  add(user) {
    const normalized = normalizeUser(user);
    this.users.push(normalized);
    return normalized;
  }
}

module.exports = UserStore;
