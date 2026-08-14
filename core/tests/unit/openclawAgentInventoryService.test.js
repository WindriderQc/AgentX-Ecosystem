'use strict';

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  buildInventoryFromState,
  buildOpenClawAgentInventory,
  collectRemoteOpenClawState,
  redactSensitiveText,
} = require('../../src/services/openclawAgentInventoryService');

let tmpRoot;

async function writeFile(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

async function writeWorkspace(workspace, files = {}) {
  await fsp.mkdir(workspace, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(workspace, name), content);
  }
}

function hashText(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'openclaw-inventory-'));
});

afterEach(async () => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});

describe('openclawAgentInventoryService', () => {
  it('normalizes configured agents with model, prompt metadata, and memory posture', async () => {
    const mainWorkspace = path.join(tmpRoot, 'workspace-main');
    const terminalWorkspace = path.join(tmpRoot, 'workspace-terminal-ops');
    const identity = '# Main\n\nFront door.\n';

    await writeWorkspace(mainWorkspace, {
      'IDENTITY.md': identity,
      'SOUL.md': '# Soul\n',
      'AGENTS.md': '# Rules\n',
      'TOOLS.md': '# Tools\n',
      'USER.md': 'Name: Example\n',
      'MEMORY.md': '# Memory\n',
    });
    await writeWorkspace(terminalWorkspace, {
      'IDENTITY.md': '# Terminal Ops\n',
      'MEMORY.md': '# Ops memory\n',
    });

    const inventory = await buildInventoryFromState({
      openclawHome: tmpRoot,
      configPath: path.join(tmpRoot, 'openclaw.json'),
      configLoaded: true,
      config: {
        defaults: {
          model: {
            primary: 'ollama/ax/gemma4:26b-a4b-it-qat',
            fallbacks: [],
          },
          workspace: mainWorkspace,
          memorySearch: {
            enabled: true,
            provider: 'ollama',
            model: 'qllama/bge-m3:f16',
            query: {
              hybrid: {
                enabled: true,
                vectorWeight: 0.7,
                textWeight: 0.3,
              },
            },
          },
        },
        list: [
          {
            id: 'main',
            default: true,
            name: 'Main',
            workspace: mainWorkspace,
            model: {
              primary: 'openrouter/example/free',
              fallbacks: ['ollama/ax/gemma4:26b-a4b-it-qat'],
            },
            tools: {
              profile: 'full',
              alsoAllow: ['read', 'memory_search'],
            },
          },
        ],
      },
      agentList: [
        {
          id: 'main',
          name: 'Main',
          identityName: 'Nestor',
          workspace: mainWorkspace,
          agentDir: '/home/agentx/.openclaw/agents/main/agent',
          model: 'openrouter/example/free',
          bindings: 0,
          isDefault: true,
        },
      ],
      memoryStatus: [
        {
          agentId: 'main',
          status: {
            dbPath: '/home/agentx/.openclaw/memory/main.sqlite',
            provider: 'ollama',
            model: 'qllama/bge-m3:f16',
            dirty: false,
            files: 1,
            chunks: 2,
            cache: { entries: 3 },
            fts: { enabled: true },
            vector: { enabled: true, dims: 1024 },
            custom: {
              searchMode: 'hybrid',
              indexIdentity: { status: 'valid' },
            },
          },
        },
      ],
    }, { generatedAt: '2026-06-20T00:00:00.000Z' });

    expect(inventory.schema_version).toBe(2);
    expect(inventory.content_mode).toBe('metadata_only');
    expect(inventory.agents).toHaveLength(1);
    expect(inventory.agents[0]).toEqual(expect.objectContaining({
      id: 'main',
      active: true,
      default: true,
      workspace: mainWorkspace,
    }));
    expect(inventory.agents[0].model).toEqual({
      primary: 'openrouter/example/free',
      fallbacks: ['ollama/ax/gemma4:26b-a4b-it-qat'],
      cloudPrimary: true,
      localFallbacks: ['ollama/ax/gemma4:26b-a4b-it-qat'],
      hasLocalFallback: true,
    });
    expect(inventory.agents[0].promptFiles['IDENTITY.md']).toEqual(expect.objectContaining({
      exists: true,
      bytes: Buffer.byteLength(identity),
      sha256: hashText(identity),
      contentMode: 'metadata_only',
    }));
    expect(inventory.agents[0].promptFiles['IDENTITY.md']).not.toHaveProperty('content');
    expect(inventory.agents[0].memory).toEqual(expect.objectContaining({
      indexStatus: 'valid',
      dirty: false,
      files: 1,
      chunks: 2,
      cacheEntries: 3,
      vectorDims: 1024,
    }));
    expect(inventory.inactiveWorkspaces.map(w => w.id)).toContain('terminal-ops');
    expect(inventory.known_gaps.some(g => g.id === 'terminal-ops-inactive-workspace')).toBe(true);
  });

  it('emits missing memory and dirty index gaps', async () => {
    const deepcodingWorkspace = path.join(tmpRoot, 'workspace-deepcoding');
    await writeWorkspace(deepcodingWorkspace, {
      'IDENTITY.md': '# DeepCoding\n',
      'SOUL.md': '# Soul\n',
    });

    const inventory = await buildInventoryFromState({
      openclawHome: tmpRoot,
      config: {
        defaults: { model: { primary: 'ollama/default', fallbacks: [] } },
        list: [{
          id: 'deepcoding',
          name: 'DeepCoding',
          workspace: deepcodingWorkspace,
          model: { primary: 'host-alpha-ollama/ax/qwen3.6:27b-mtp-q8_0', fallbacks: [] },
        }],
      },
      agentList: [],
      memoryStatus: [{
        agentId: 'deepcoding',
        status: {
          dirty: true,
          custom: { indexIdentity: { status: 'missing' } },
        },
        scan: {
          issues: ['memory directory missing'],
        },
      }],
    });

    const deepcoding = inventory.agents.find(a => a.id === 'deepcoding');
    expect(deepcoding.promptFiles['MEMORY.md'].missing).toBe(true);
    expect(deepcoding.memory.indexStatus).toBe('missing');
    expect(deepcoding.memory.issues).toEqual(expect.arrayContaining([
      'memory directory missing',
      'MEMORY.md missing from workspace root',
    ]));
    expect(inventory.known_gaps.map(g => g.id)).toEqual(expect.arrayContaining([
      'deepcoding-memory-index-missing',
      'deepcoding-missing-memory-md',
    ]));
    expect(inventory.known_gaps.map(g => g.id)).not.toContain('deepcoding-missing-local-fallback');
  });

  it('redacts bounded prompt content only when explicitly requested', async () => {
    const workspace = path.join(tmpRoot, 'workspace-main');
    await writeWorkspace(workspace, {
      'IDENTITY.md': '# Main\napiKey: sk-1234567890abcdef\n',
      'USER.md': 'token: this-is-a-sensitive-token\n',
      'MEMORY.md': '# Memory\n',
    });

    const inventory = await buildInventoryFromState({
      openclawHome: tmpRoot,
      config: {
        defaults: { model: { primary: 'ollama/default', fallbacks: [] } },
        list: [{ id: 'main', workspace }],
      },
      agentList: [],
      memoryStatus: [],
    }, { includeContent: true, maxContentChars: 200 });

    const identity = inventory.agents[0].promptFiles['IDENTITY.md'];
    const user = inventory.agents[0].promptFiles['USER.md'];
    expect(identity.contentMode).toBe('bounded_redacted');
    expect(identity.content).toContain('[REDACTED_SECRET]');
    expect(identity.content).not.toContain('sk-1234567890abcdef');
    expect(user.contentPrivate).toBe(true);
    expect(user.content).toContain('[REDACTED_SECRET]');
    expect(user.content).not.toContain('this-is-a-sensitive-token');
  });

  it('degrades gracefully when OpenClaw config is unavailable', async () => {
    const inventory = await buildOpenClawAgentInventory({
      openclawHome: path.join(tmpRoot, 'missing'),
      configPath: path.join(tmpRoot, 'missing', 'openclaw.json'),
      useCli: false,
    });

    expect(inventory.source.degraded).toBe(true);
    expect(inventory.source.issues[0]).toMatch(/Could not read OpenClaw config/);
    expect(inventory.agents).toEqual([]);
  });

  it('collects remote OpenClaw state through an injected SSH runner', async () => {
    const home = '/home/agentx/.openclaw';
    const workspace = `${home}/workspace-main`;
    const identity = '# Main\n';
    const sshRunner = jest.fn((_target, command) => {
      if (command.includes('AGENTX_OPENCLAW_HOME=')) {
        return JSON.stringify({
          defaults: {
            model: { primary: 'ollama/ax/gemma4:26b-a4b-it-qat', fallbacks: [] },
            workspace,
          },
          list: [{
            id: 'main',
            name: 'Main',
            workspace,
            model: {
              primary: 'openrouter/example/free',
              fallbacks: ['ollama/ax/gemma4:26b-a4b-it-qat'],
            },
          }],
        });
      }
      if (command.includes('agents list')) {
        return JSON.stringify([{
          id: 'main',
          name: 'Main',
          identityName: 'Nestor',
          workspace,
          model: 'openrouter/example/free',
          isDefault: true,
        }]);
      }
      if (command.includes('memory status')) {
        return JSON.stringify([{
          agentId: 'main',
          status: {
            dirty: false,
            custom: { indexIdentity: { status: 'valid' } },
          },
        }]);
      }
      if (command.includes('python3')) {
        return JSON.stringify([
          {
            workspace,
            name: 'IDENTITY.md',
            path: `${workspace}/IDENTITY.md`,
            exists: true,
            bytes: Buffer.byteLength(identity),
            sha256: hashText(identity),
          },
          {
            workspace,
            name: 'MEMORY.md',
            path: `${workspace}/MEMORY.md`,
            exists: true,
            bytes: 9,
            sha256: hashText('# Memory\n'),
          },
        ]);
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const state = await collectRemoteOpenClawState({
      sshTarget: 'operator@example',
      remoteOpenClawHome: home,
      sshRunner,
    });
    const inventory = await buildOpenClawAgentInventory({
      state,
      generatedAt: '2026-06-20T00:00:00.000Z',
    });

    expect(sshRunner).toHaveBeenCalledWith(
      'operator@example',
      expect.stringContaining('AGENTX_OPENCLAW_HOME='),
      expect.any(Object)
    );
    const configCommand = sshRunner.mock.calls.find(([, command]) => command.includes('AGENTX_OPENCLAW_HOME='))[1];
    const promptCommand = sshRunner.mock.calls.find(([, command]) => command.includes('INCLUDE_CONTENT='))[1];
    expect(sshRunner.mock.calls.some(([, command]) => command.includes('config get agents'))).toBe(false);
    expect(configCommand).toContain('/home/agentx/.openclaw');
    expect(configCommand).not.toMatch(/["'](?:apiKey|token|secret|password|authorization|credential)["']/i);
    expect(promptCommand).toContain(`OPENCLAW_HOME='${home}'`);
    expect(state.degraded).toBe(false);
    expect(state.configSource).toBe('ssh sanitized openclaw.json agents');
    expect(inventory.source.agentListSource).toBe('ssh openclaw agents list --json --bindings');
    expect(inventory.source.configSource).toBe('ssh sanitized openclaw.json agents');
    expect(inventory.agents).toHaveLength(1);
    expect(JSON.stringify(inventory)).not.toMatch(/"(?:apiKey|token|secret|password|authorization|credential)"/i);
    expect(inventory.agents[0].model.hasLocalFallback).toBe(true);
    expect(inventory.agents[0].promptFiles['IDENTITY.md']).toEqual(expect.objectContaining({
      exists: true,
      sha256: hashText(identity),
      contentMode: 'metadata_only',
    }));
  });

  it('can skip the remote bindings list for fast snapshot probes', async () => {
    const home = '/home/agentx/.openclaw';
    const workspace = `${home}/workspace-main`;
    const sshRunner = jest.fn((_target, command) => {
      if (command.includes('agents list')) {
        throw new Error('bindings list should not be called');
      }
      if (command.includes('memory status')) {
        throw new Error('memory status should not be called');
      }
      if (command.includes('AGENTX_OPENCLAW_HOME=')) {
        return JSON.stringify({
          defaults: {
            model: { primary: 'ollama/default', fallbacks: [] },
            workspace,
          },
          list: [{
            id: 'main',
            name: 'Main',
            workspace,
            model: { primary: 'ollama/main', fallbacks: [] },
          }],
        });
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const state = await collectRemoteOpenClawState({
      sshTarget: 'operator@example',
      remoteOpenClawHome: home,
      includeAgentBindings: false,
      includeMemoryStatus: false,
      includePromptFiles: false,
      sshRunner,
    });

    expect(sshRunner.mock.calls.some(([, command]) => command.includes('agents list'))).toBe(false);
    expect(sshRunner.mock.calls.some(([, command]) => command.includes('memory status'))).toBe(false);
    expect(sshRunner.mock.calls.some(([, command]) => command.includes('config get agents'))).toBe(false);
    expect(state.degraded).toBe(false);
    expect(state.configSource).toBe('ssh sanitized openclaw.json agents');
    expect(state.agentListSource).toBe('ssh sanitized openclaw.json agents');
    expect(state.memoryStatusSource).toBe('skipped');
    expect(state.agentList).toEqual([expect.objectContaining({
      id: 'main',
      workspace,
      model: 'ollama/main',
    })]);

    const inventory = await buildOpenClawAgentInventory({
      state,
      includePromptFiles: false,
      generatedAt: '2026-06-20T00:00:00.000Z',
    });

    expect(inventory.source.promptFilesSource).toBe('skipped');
    expect(inventory.source.memoryStatusSource).toBe('skipped');
    expect(inventory.agents[0].promptFiles).toEqual({});
    expect(inventory.agents[0].memory.indexStatus).toBe('unknown');
    expect(inventory.known_gaps.map(g => g.id)).not.toContain('main-missing-memory-md');
    expect(inventory.known_gaps.map(g => g.id)).not.toContain('main-memory-index-unavailable');
  });

  it('falls back to the OpenClaw CLI when the sanitized remote projection is unavailable', async () => {
    const home = '/home/agentx/.openclaw';
    const workspace = `${home}/workspace-main`;
    const sshRunner = jest.fn((_target, command) => {
      if (command.includes('AGENTX_OPENCLAW_HOME=')) {
        throw new Error('python3 unavailable');
      }
      if (command.includes('config get agents')) {
        return JSON.stringify({
          defaults: {
            model: { primary: 'ollama/default', fallbacks: [] },
            workspace,
          },
          list: [{
            id: 'main',
            name: 'Main',
            workspace,
            model: { primary: 'ollama/main', fallbacks: [] },
          }],
        });
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const state = await collectRemoteOpenClawState({
      sshTarget: 'operator@example',
      remoteOpenClawHome: home,
      includeAgentBindings: false,
      includeMemoryStatus: false,
      includePromptFiles: false,
      sshRunner,
    });

    expect(sshRunner.mock.calls.map(([, command]) => command)).toEqual([
      expect.stringContaining('AGENTX_OPENCLAW_HOME='),
      expect.stringContaining('openclaw config get agents --json'),
    ]);
    expect(state.degraded).toBe(false);
    expect(state.configLoaded).toBe(true);
    expect(state.configSource).toBe('ssh openclaw config get agents --json');
    expect(state.agentListSource).toBe('ssh openclaw config get agents --json');
    expect(state.agentList).toEqual([expect.objectContaining({ id: 'main' })]);
  });

  it('redacts common secret patterns in free text', () => {
    expect(redactSensitiveText('Authorization: Bearer abcdefghijklmnop')).toContain('[REDACTED_SECRET]');
    expect(redactSensitiveText('password: hunter2-password')).toContain('[REDACTED_SECRET]');
  });
});
