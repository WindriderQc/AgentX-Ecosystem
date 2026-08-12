const systemHealth = {
  mongodb: { status: 'checking', lastCheck: null, error: null },
  ollama: { status: 'checking', lastCheck: null, error: null },
  startup: new Date().toISOString()
};

module.exports = systemHealth;
