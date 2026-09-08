import { Buffer } from 'node:buffer';

export const DEFAULT_CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex';
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_WORKING_DIRECTORY = process.cwd();

const ALLOWED_MCP_SERVER = 'cua_repl';
const ALLOWED_MCP_TOOLS = new Set(['js', 'js_reset']);
const SHELL_ITEM_TYPES = new Set([
  'command_execution',
  'local_shell_call',
  'shell_command',
  'shell_call',
  'terminal_command',
]);

export function buildCodexArgv(codexPath) {
  return [
    codexPath,
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
  ];
}

export function buildCodexPrompt(task) {
  const normalized = typeof task === 'string' ? task.trim() : '';
  if (!normalized) throw new Error('task must be a non-empty string');
  return [
    'You are the desktop-operation worker for DeepSeek Harness.',
    'Use only Codex Computer Use for local macOS GUI interaction.',
    'Do not use shell commands, command execution, Python, JavaScript outside the built-in CUA surface, AppleScript, osascript, filesystem APIs, or web-search tools.',
    'Before each UI action, obtain a fresh observation and act only on the current UI state.',
    'Perform only the requested task and report the final observed result concisely.',
    '',
    'User task:',
    normalized,
  ].join('\n');
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function itemOf(event) {
  return event && typeof event.item === 'object' && event.item !== null ? event.item : {};
}

function itemType(event) {
  return stringValue(itemOf(event).type).toLowerCase();
}

function itemTool(event) {
  const item = itemOf(event);
  return stringValue(item.tool ?? item.name ?? item.tool_name).toLowerCase();
}

function itemServer(event) {
  return stringValue(itemOf(event).server ?? item.server).toLowerCase();
}

export function isShellEvent(event) {
  const type = itemType(event);
  const tool = itemTool(event);
  if (SHELL_ITEM_TYPES.has(type)) return true;
  if (/^(bash|zsh|sh|osascript|python|python3|node|terminal)$/.test(tool)) return true;
  return /(?:command[_-]?execution|local[_-]?shell|shell[_-]?command|terminal[_-]?command)/.test(`${type} ${tool}`);
}

export function isAllowedMcpEvent(event) {
  if (itemType(event) !== 'mcp_tool_call') return true;
  return itemServer(event) === ALLOWED_MCP_SERVER && ALLOWED_MCP_TOOLS.has(itemTool(event));
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    return '';
  }).filter(Boolean).join('');
}

function eventLabel(event) {
  const type = stringValue(event?.type);
  const item = itemOf(event);
  const itemTypeValue = stringValue(item.type);
  const tool = stringValue(item.tool ?? item.name ?? item.tool_name);
  if (itemTypeValue && tool) return `${itemTypeValue}:${tool}`;
  if (itemTypeValue) return itemTypeValue;
  return type || 'unknown';
}

export function createEventState() {
  return {
    threadId: undefined,
    finalMessage: '',
    errorMessage: '',
    fatalError: false,
    shellBlocked: false,
    toolBlocked: false,
    malformedLines: 0,
    eventLabels: [],
  };
}

export function consumeCodexEvent(state, event) {
  if (!event || typeof event !== 'object') return state;
  const label = eventLabel(event);
  if (label && !state.eventLabels.includes(label)) state.eventLabels.push(label);
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') state.threadId = event.thread_id;
  if (isShellEvent(event)) state.shellBlocked = true;
  if (itemType(event) === 'mcp_tool_call' && !isAllowedMcpEvent(event)) state.toolBlocked = true;

  const item = itemOf(event);
  if (item.type === 'agent_message' || item.type === 'assistant_message') {
    const text = extractText(item.text ?? item.content ?? item.message);
    if (text) state.finalMessage = text;
  }
  if (event.type === 'error' || event.type === 'turn.failed' || event.type === 'turn.error' || item.type === 'error') {
    const message = extractText(event.message ?? event.error ?? event.reason ?? item.message);
    if (message) state.errorMessage = message;
    state.fatalError = true;
  }
  return state;
}

export function consumeCodexJsonLine(state, line) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (!text) return state;
  try {
    return consumeCodexEvent(state, JSON.parse(text));
  } catch {
    state.malformedLines += 1;
    return state;
  }
}

export function parseCodexJsonl(text) {
  const state = createEventState();
  for (const line of String(text ?? '').split(/\r?\n/)) consumeCodexJsonLine(state, line);
  return state;
}

export function redactDiagnostic(text) {
  return String(text ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[redacted-token]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/(password|secret|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(-2_000);
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function resultMessage(state, outcome, stderr, status) {
  if (status === 'shell_blocked') return 'Codex attempted a shell or command-execution tool; the request was stopped by the DSH safety guard.';
  if (status === 'tool_blocked') return 'Codex attempted a non-CUA MCP tool; the request was stopped by the DSH safety guard.';
  if (status === 'timeout') return 'Codex Computer Use timed out before returning a final result.';
  if (status === 'aborted') return 'Codex Computer Use was cancelled.';
  if (status === 'output_limit') return 'Codex Computer Use produced more output than the configured safety limit.';
  if (state.finalMessage) return state.finalMessage;
  if (state.errorMessage) return state.errorMessage;
  if (stderr) return `Codex exited without a final message: ${redactDiagnostic(stderr)}`;
  if (outcome?.exitCode !== 0) return `Codex exited with code ${outcome?.exitCode ?? 'unknown'}.`;
  return 'Codex completed without a final message.';
}

export async function runCodexComputerUse({
  subprocess,
  codexPath = DEFAULT_CODEX_PATH,
  task,
  workingDirectory = DEFAULT_WORKING_DIRECTORY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  signal,
}) {
  if (!subprocess || typeof subprocess.spawn !== 'function' || typeof subprocess.resolveExecutable !== 'function') {
    throw new Error('the DSH subprocess capability is unavailable');
  }
  if (signal?.aborted) return { ok: false, status: 'aborted', message: 'Codex Computer Use was cancelled.', events: [] };
  const prompt = buildCodexPrompt(task);
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const effectiveOutputLimit = Number.isFinite(maxOutputBytes) && maxOutputBytes > 0 ? maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
  const executable = await subprocess.resolveExecutable(codexPath, undefined, signal);
  const state = createEventState();
  let stdoutBytes = 0;
  let stdoutBuffer = '';
  let outputLimit = false;
  let timedOut = false;
  let timer;
  let handle;

  try {
    handle = subprocess.spawn({
      argv: buildCodexArgv(executable),
      cwd: workingDirectory,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 2_000,
      signal,
      env: { CUA_REPL_ENABLED_SURFACES: 'computer' },
    });
    handle.stdin?.end(prompt);
    timer = setTimeout(() => {
      timedOut = true;
      handle.terminate();
    }, effectiveTimeout);

    const stdoutDone = new Promise((resolve, reject) => {
      if (!handle.stdout) return resolve();
      handle.stdout.on('data', (chunk) => {
        if (outputLimit) return;
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        stdoutBytes += byteLength(text);
        if (stdoutBytes > effectiveOutputLimit) {
          outputLimit = true;
          handle.terminate();
          return;
        }
        stdoutBuffer += text;
        let newline;
        while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          consumeCodexJsonLine(state, line);
          if (state.shellBlocked || state.toolBlocked || state.fatalError) handle.terminate();
        }
      });
      handle.stdout.once('error', reject);
      handle.stdout.once('end', () => {
        if (!outputLimit && stdoutBuffer.trim()) consumeCodexJsonLine(state, stdoutBuffer);
        resolve();
      });
    });

    const outcome = await handle.done;
    await stdoutDone;
    const stderr = handle.collected.stderr?.readFrom(0).text ?? '';
    clearTimeout(timer);
    const status = state.shellBlocked
      ? 'shell_blocked'
      : state.toolBlocked
        ? 'tool_blocked'
        : outputLimit
          ? 'output_limit'
          : signal?.aborted
            ? 'aborted'
            : timedOut
              ? 'timeout'
              : !state.fatalError && outcome.exitCode === 0 && state.finalMessage
                ? 'completed'
                : 'failed';
    return {
      ok: status === 'completed',
      status,
      message: resultMessage(state, outcome, stderr, status),
      ...(state.threadId ? { threadId: state.threadId } : {}),
      events: state.eventLabels.slice(0, 32),
      ...(state.malformedLines ? { malformedLines: state.malformedLines } : {}),
      ...(status === 'failed' && stderr ? { diagnostic: redactDiagnostic(stderr) } : {}),
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (handle) handle.terminate();
    if (signal?.aborted) return { ok: false, status: 'aborted', message: 'Codex Computer Use was cancelled.', events: [] };
    return {
      ok: false,
      status: 'failed',
      message: error instanceof Error ? error.message : 'Unable to start Codex Computer Use.',
      events: [],
    };
  }
}
