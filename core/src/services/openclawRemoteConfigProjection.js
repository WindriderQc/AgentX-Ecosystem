'use strict';

const DIRECT_CONFIG_SOURCE = 'ssh sanitized openclaw.json agents';
const CLI_CONFIG_SOURCE = 'ssh openclaw config get agents --json';

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Read only the inventory-safe part of OpenClaw's agents configuration on the
 * remote host. The projection happens before stdout leaves the host, so Core
 * never receives provider credentials or unrelated runtime configuration.
 */
function buildRemoteAgentsConfigCommand(openclawHome) {
  return `AGENTX_OPENCLAW_HOME=${shellSingleQuote(openclawHome)} python3 - <<'PY'
import json, os, pathlib

root = pathlib.Path(os.environ["AGENTX_OPENCLAW_HOME"])
with (root / "openclaw.json").open("r", encoding="utf-8") as handle:
    raw = json.load(handle)

agents = raw.get("agents") if isinstance(raw, dict) else {}
agents = agents if isinstance(agents, dict) else {}

def pick(value, keys):
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in keys if key in value}

def project_model(value):
    return pick(value, ("primary", "fallbacks"))

def project_subagents(value):
    return pick(value, ("maxConcurrent", "archiveAfterMinutes", "allowAgents"))

def project_memory_search(value):
    projected = pick(value, ("enabled", "provider", "model", "fallback", "sources"))
    query = value.get("query") if isinstance(value, dict) else None
    hybrid = query.get("hybrid") if isinstance(query, dict) else None
    if isinstance(hybrid, dict):
        projected["query"] = {
            "hybrid": pick(hybrid, ("enabled", "vectorWeight", "textWeight"))
        }
    return projected

def project_tools(value):
    projected = pick(value, ("profile", "alsoAllow", "no_exec", "noExec"))
    execute = value.get("exec") if isinstance(value, dict) else None
    if isinstance(execute, dict):
        projected["exec"] = pick(
            execute,
            ("host", "security", "ask", "timeoutSec", "timeoutSeconds"),
        )
    return projected

defaults_raw = agents.get("defaults")
defaults_raw = defaults_raw if isinstance(defaults_raw, dict) else {}
defaults = pick(defaults_raw, ("workspace", "timeoutSeconds", "maxConcurrent"))
if isinstance(defaults_raw.get("model"), dict):
    defaults["model"] = project_model(defaults_raw["model"])
if isinstance(defaults_raw.get("memorySearch"), dict):
    defaults["memorySearch"] = project_memory_search(defaults_raw["memorySearch"])
if isinstance(defaults_raw.get("compaction"), dict):
    defaults["compaction"] = pick(defaults_raw["compaction"], ("mode", "reserveTokens"))
if isinstance(defaults_raw.get("subagents"), dict):
    defaults["subagents"] = project_subagents(defaults_raw["subagents"])

projected_agents = []
for item in agents.get("list", []):
    if not isinstance(item, dict):
        continue
    projected = pick(item, (
        "id", "default", "name", "workspace", "thinkingDefault",
        "bootstrapMaxChars", "bootstrapTotalMaxChars", "skills",
    ))
    if isinstance(item.get("model"), dict):
        projected["model"] = project_model(item["model"])
    if isinstance(item.get("identity"), dict):
        projected["identity"] = pick(item["identity"], ("name", "emoji"))
    if isinstance(item.get("subagents"), dict):
        projected["subagents"] = project_subagents(item["subagents"])
    if isinstance(item.get("tools"), dict):
        projected["tools"] = project_tools(item["tools"])
    projected_agents.append(projected)

print(json.dumps({"defaults": defaults, "list": projected_agents}, ensure_ascii=False, separators=(",", ":")))
PY`;
}

async function loadRemoteAgentsConfig({
  target,
  openclawHome,
  cliPrefix = '',
  options = {},
  runJson,
}) {
  if (typeof runJson !== 'function') throw new TypeError('runJson is required');

  try {
    const config = await runJson(
      target,
      buildRemoteAgentsConfigCommand(openclawHome),
      options
    );
    return { config: config || {}, source: DIRECT_CONFIG_SOURCE };
  } catch (directError) {
    try {
      const config = await runJson(
        target,
        `${cliPrefix}openclaw config get agents --json`,
        options
      );
      return { config: config || {}, source: CLI_CONFIG_SOURCE };
    } catch (cliError) {
      const error = new Error(
        `sanitized config projection failed (${directError.message}); `
        + `OpenClaw CLI fallback failed (${cliError.message})`
      );
      error.cause = cliError;
      throw error;
    }
  }
}

module.exports = {
  CLI_CONFIG_SOURCE,
  DIRECT_CONFIG_SOURCE,
  buildRemoteAgentsConfigCommand,
  loadRemoteAgentsConfig,
};
