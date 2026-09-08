import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexArgv,
  buildCodexPrompt,
  consumeCodexEvent,
  createEventState,
  isAllowedMcpEvent,
  isShellEvent,
  parseCodexJsonl,
  redactDiagnostic,
} from '../lib/codex.js';

test('buildCodexArgv uses a fixed, shell-disabled Computer Use invocation', () => {
  const argv = buildCodexArgv('/Applications/Codex.app/Contents/MacOS/codex');
  assert.deepEqual(argv, [
    '/Applications/Codex.app/Contents/MacOS/codex',
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--disable',
    'shell_tool',
    '--disable',
    'unified_exec',
    '-c',
    'notify=[]',
    '-c',
    'mcp_servers.node_repl.enabled=false',
    '-c',
    'mcp_servers.computer-use.enabled=false',
    '-',
  ]);
  assert.equal(argv.includes('danger-full-access'), false);
  assert.equal(argv.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});

test('buildCodexPrompt establishes the GUI-only delegation boundary', () => {
  const prompt = buildCodexPrompt('Open Calculator and report the displayed result.');
  assert.match(prompt, /Codex Computer Use/);
  assert.match(prompt, /Do not use shell commands/);
  assert.match(prompt, /fresh observation/);
  assert.match(prompt, /Open Calculator/);
});

test('shell events are rejected while CUA REPL events are allowed', () => {
  assert.equal(isShellEvent({ type: 'item.started', item: { type: 'command_execution' } }), true);
  assert.equal(isShellEvent({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js' } }), false);
  assert.equal(isAllowedMcpEvent({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js' } }), true);
  assert.equal(isAllowedMcpEvent({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'browser', tool: 'open' } }), false);
});

test('parseCodexJsonl extracts final result and audits event kinds', () => {
  const state = parseCodexJsonl([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Calculator shows 288.' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n'));
  assert.equal(state.threadId, 'thread-1');
  assert.equal(state.finalMessage, 'Calculator shows 288.');
  assert.equal(state.shellBlocked, false);
  assert.equal(state.toolBlocked, false);
  assert.deepEqual(state.eventLabels, ['thread.started', 'mcp_tool_call:js', 'agent_message', 'turn.completed']);
});

test('a command event taints the run even if a later message is successful', () => {
  const state = createEventState();
  consumeCodexEvent(state, { type: 'item.started', item: { type: 'command_execution', command: '/bin/echo unsafe' } });
  consumeCodexEvent(state, { type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
  assert.equal(state.shellBlocked, true);
  assert.equal(state.finalMessage, 'done');
});

test('diagnostics redact common credential formats', () => {
  const redacted = redactDiagnostic('Authorization: Bearer ghp_abc123 secret=topsecret');
  assert.equal(redacted.includes('ghp_abc123'), false);
  assert.equal(redacted.includes('topsecret'), false);
  assert.match(redacted, /redacted/);
});
