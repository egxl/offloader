const noOffloadPatterns = [
  /(?:^|[\s(["'])(\/no-offload)(?=$|[\s.,;:!?)\]"'])/i,
  /(?:^|[\s(["'])(--no-offload)(?=$|[\s.,;:!?)\]"'])/i,
  /(\[no-offload\])/i,
];

function findNoOffloadTrigger(input) {
  if (typeof input !== 'string' || !input) return null;

  for (const pattern of noOffloadPatterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function isOffloadWorkerToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return false;

  const name = typeof toolCall.name === 'string' ? toolCall.name : '';
  if (name === 'call_mcp_tool') {
    const args = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {};
    const serverName = args.ServerName ?? args.serverName ?? args.server_name ?? '';
    return typeof serverName === 'string' && /(?:^|_)offload-worker$/i.test(serverName);
  }
  return /^mcp_(?:offload-worker_)?offload-worker_/i.test(name);
}

function evaluateHook(payload) {
  if (!payload || typeof payload !== 'object') return { decision: 'allow' };
  if (!isOffloadWorkerToolCall(payload.toolCall)) return { decision: 'allow' };

  const trigger = findNoOffloadTrigger(payload.lastUserInput);
  if (!trigger) return { decision: 'allow' };

  return {
    decision: 'deny',
    reason: `offload-worker is disabled for this turn (matched "${trigger}"). Execute directly in Antigravity without calling offload_task, generate_image, or list_offload_models.`,
  };
}

async function main() {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    // Empty or malformed input leaves the hook with no call to block.
  }

  const result = evaluateHook(payload);
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { findNoOffloadTrigger, isOffloadWorkerToolCall, evaluateHook };

if (require.main === module) {
  main();
}
