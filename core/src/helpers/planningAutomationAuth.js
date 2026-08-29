const { tokenAllowed } = require('./mcpToken');

function planningAutomationAllowed(req) {
  const configured = Boolean(String(process.env.AGENTX_MCP_TOKEN || '').trim());
  if (process.env.NODE_ENV === 'production' && !configured) {
    return {
      allowed: false,
      status: 503,
      code: 'PLANNING_AUTOMATION_TOKEN_REQUIRED',
      message: 'Planning automation requires AGENTX_MCP_TOKEN in production'
    };
  }
  // Preserve the existing local development fallback without adopting the
  // MCP route's broader trusted-local/operator ingress contract.
  if (!tokenAllowed(req, { allowUnset: true })) {
    return {
      allowed: false,
      status: 401,
      code: 'PLANNING_AUTOMATION_UNAUTHORIZED',
      message: 'Unauthorized'
    };
  }
  return { allowed: true };
}

module.exports = { planningAutomationAllowed };
