function normalizeUser(user) {
  return { ...user, name: String(user.name).trim(), email: String(user.email).trim() };
}
module.exports = normalizeUser;
