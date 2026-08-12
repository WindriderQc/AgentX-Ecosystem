// Shared token gate for the MCP skill bus. Core runs no auth middleware by
// design; this is the deliberate, explicit exception for the bus.
//
// Fail-open when AGENTX_MCP_TOKEN is unset (matches the no-auth default — local
// callers keep working). Set the env var and the bus requires it.
function tokenAllowed(req) {
  const expected = process.env.AGENTX_MCP_TOKEN || '';
  if (!expected) return true;
  const auth = req.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const header = req.get('x-agentx-mcp-token') || '';
  return bearer === expected || header === expected;
}

module.exports = { tokenAllowed };
