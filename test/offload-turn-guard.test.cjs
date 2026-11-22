const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { findNoOffloadTrigger, isOffloadWorkerToolCall, evaluateHook } = require('../offload-turn-guard.cjs');

const guardPath = join(__dirname, '..', 'offload-turn-guard.cjs');
const workerServers = ['offload-worker_offload-worker', 'offload-worker'];
const workerTools = ['offload_task', 'generate_image', 'list_offload_models'];
const triggerCases = [
  ['/NO-Offload please run the tests', '/NO-Offload'],
  ['Run the tests ("--No-Offload"), then summarize.', '--No-Offload'],
  ['Run the tests, [No-Offload]', '[No-Offload]'],
];
const nonTriggers = ['https://example.com/no-offload', 'foo--no-offload-bar', '/no-offload-extra'];
const eagerToolNames = ['mcp_offload-worker_offload-worker_offload_task', 'mcp_offload-worker_offload_task'];
const unrelatedTools = [
  mcpCall('canva_canva', 'search'),
  mcpCall('scrapling_scrapling', 'fetch'),
  { name: 'run_command' },
  { name: 'read_file' },
];

function mcpCall(server, tool) {
  return { name: 'call_mcp_tool', args: { ServerName: server, ToolName: tool } };
}

function denial(trigger) {
  return {
    decision: 'deny',
    reason: `offload-worker is disabled for this turn (matched "${trigger}"). Execute directly in Antigravity without calling offload_task, generate_image, or list_offload_models.`,
  };
}

function assertCliDecision(input, expected) {
  const result = spawnSync(process.execPath, [guardPath], { input, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

test('findNoOffloadTrigger preserves casing at the start, middle, and end of a prompt', () => {
  for (const [input, trigger] of triggerCases) {
    assert.equal(findNoOffloadTrigger(input), trigger, input);
  }
  assert.equal(findNoOffloadTrigger('[/no-offload]!'), '/no-offload');
  assert.equal(findNoOffloadTrigger("'--no-offload';"), '--no-offload');
});

test('findNoOffloadTrigger ignores URLs, hyphenated words, and invalid input', () => {
  for (const input of [...nonTriggers, 'Run the tests', '', null, undefined, 42, {}]) {
    assert.equal(findNoOffloadTrigger(input), null, String(input));
  }
});

test('isOffloadWorkerToolCall recognizes MCP server aliases and eager tool names', () => {
  for (const server of workerServers) {
    assert.equal(isOffloadWorkerToolCall(mcpCall(server, 'offload_task')), true);
  }
  for (const key of ['ServerName', 'serverName', 'server_name']) {
    assert.equal(isOffloadWorkerToolCall({ name: 'call_mcp_tool', args: { [key]: 'OFFLOAD-WORKER' } }), true);
  }
  for (const name of eagerToolNames) {
    assert.equal(isOffloadWorkerToolCall({ name }), true);
  }
});

test('isOffloadWorkerToolCall ignores unrelated and invalid tool calls', () => {
  for (const toolCall of [...unrelatedTools, null, 'offload-worker', { name: 42 }, { name: 'call_mcp_tool', args: 42 }, mcpCall(42, 'offload_task')]) {
    assert.equal(isOffloadWorkerToolCall(toolCall), false);
  }
});

test('evaluateHook allows offload calls on turns without an opt-out', () => {
  for (const server of workerServers) {
    const toolCall = mcpCall(server, 'offload_task');
    for (const lastUserInput of ['Run the tests', ...nonTriggers]) {
      assert.deepEqual(evaluateHook({ toolCall, lastUserInput }), { decision: 'allow' });
    }
  }
});

test('evaluateHook denies every offload tool for each opt-out token', () => {
  for (const server of workerServers) {
    for (const tool of workerTools) {
      for (const [lastUserInput, trigger] of triggerCases) {
        assert.deepEqual(evaluateHook({ toolCall: mcpCall(server, tool), lastUserInput }), denial(trigger));
      }
    }
  }
  for (const name of eagerToolNames) {
    assert.deepEqual(evaluateHook({ toolCall: { name }, lastUserInput: '/no-offload' }), denial('/no-offload'));
  }
});

test('evaluateHook allows unrelated tools and invalid payloads', () => {
  for (const toolCall of unrelatedTools) {
    assert.deepEqual(evaluateHook({ toolCall, lastUserInput: '/no-offload' }), { decision: 'allow' });
  }
  for (const payload of [null, 42, '/no-offload', { lastUserInput: '/no-offload' }]) {
    assert.deepEqual(evaluateHook(payload), { decision: 'allow' });
  }
});

test('CLI reads tool calls from stdin and writes a JSON decision followed by a newline', () => {
  const cases = [
    [mcpCall(workerServers[0], 'offload_task'), 'Run the tests', { decision: 'allow' }],
    [mcpCall(workerServers[1], 'generate_image'), 'Use https://example.com/no-offload', { decision: 'allow' }],
    [mcpCall(workerServers[0], 'list_offload_models'), '/NO-OFFLOAD!', denial('/NO-OFFLOAD')],
    [{ name: eagerToolNames[1] }, 'Run the tests (--no-offload).', denial('--no-offload')],
    [{ name: eagerToolNames[0] }, 'Run the tests [no-offload]', denial('[no-offload]')],
    [mcpCall('canva_canva', 'search'), '/no-offload Search Canva', { decision: 'allow' }],
    [{ name: 'read_file' }, '/no-offload Read the file', { decision: 'allow' }],
  ];
  for (const [toolCall, lastUserInput, expected] of cases) {
    assertCliDecision(JSON.stringify({ toolCall, lastUserInput }), expected);
  }
});

test('CLI fails open when stdin is empty or malformed', () => {
  for (const input of ['', '{broken json']) {
    assertCliDecision(input, { decision: 'allow' });
  }
});

test('hooks.json enables the PreToolUse command for offload tool calls', () => {
  const hooks = JSON.parse(readFileSync(join(__dirname, '..', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks, {
    'offload-turn-guard': {
      enabled: true,
      PreToolUse: [
        {
          matcher: 'call_mcp_tool|mcp_.*offload.*',
          hooks: [{ type: 'command', command: 'node ./offload-turn-guard.cjs', timeout: 5 }],
        },
      ],
    },
  });
});
