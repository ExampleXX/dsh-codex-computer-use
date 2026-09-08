import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  DEFAULT_CODEX_PATH,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WORKING_DIRECTORY,
  runCodexComputerUse,
} from './codex.js';

export const name = 'dsh-codex-computer-use';
export const inject = ['tools', 'systemPrompt', 'subprocess'];

const TOOL_NAME = 'codex_computer_use';
const SYSTEM_PROMPT_NAME = 'TOOL_CODEX_COMPUTER_USE';
const SYSTEM_PROMPT_ORDER = 110;
const description = [
  'Use this tool whenever a task requires interacting with the local macOS GUI: seeing a window, opening an app, clicking, typing, dragging, selecting, or verifying a visual result.',
  'This is the default GUI route. It delegates the task to the local Codex Computer Use runtime.',
  'Do not use bash, AppleScript, osascript, Python, browser automation, or direct shell commands for GUI work.',
].join(' ');

const systemPromptText = [
  '## Local desktop interaction policy',
  '',
  'When a task requires seeing or changing the local macOS graphical interface, use `codex_computer_use` as the default route. Do not use bash, AppleScript, osascript, Python, browser automation, or direct shell commands to operate GUI applications.',
  'Use ordinary file, web, and developer tools for non-GUI work. Do not ask the user to repeat this routing instruction.',
].join('\n');

function positiveNumber(value, fallback, maximum) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function resolveWorkingDirectory(config, exec) {
  const configured = typeof config.workingDirectory === 'string' && config.workingDirectory.trim()
    ? config.workingDirectory.trim()
    : undefined;
  const sessionCwd = exec.agent?.session?.header?.cwd;
  return configured ?? (typeof sessionCwd === 'string' && sessionCwd ? sessionCwd : DEFAULT_WORKING_DIRECTORY);
}

export function apply(ctx, config = {}) {
  const codexPath = typeof config.codexPath === 'string' && config.codexPath.trim()
    ? config.codexPath.trim()
    : DEFAULT_CODEX_PATH;
  const timeoutMs = positiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS, 300_000);
  const maxOutputBytes = positiveNumber(config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 4 * 1024 * 1024);

  ctx.systemPrompt.section({
    name: SYSTEM_PROMPT_NAME,
    order: SYSTEM_PROMPT_ORDER,
    text: systemPromptText,
  });

  const dispose = ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description,
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'The concrete macOS GUI task for Codex Computer Use to perform and verify.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          message: { type: 'string', required: true },
          threadId: { type: 'string' },
          events: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          malformedLines: { type: 'integer' },
          diagnostic: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) throw new Error('task must be a non-empty string');
      if (task.length > 8_000) throw new Error('task is too long; keep the GUI request under 8,000 characters');
      return runCodexComputerUse({
        subprocess: ctx.subprocess,
        codexPath,
        task,
        workingDirectory: resolveWorkingDirectory(config, exec),
        timeoutMs,
        maxOutputBytes,
        signal: exec.signal,
      });
    },
  }));

  ctx.effect(() => () => {
    if (typeof dispose === 'function') dispose();
  }, 'dsh-codex-computer-use: dispose tool');
}

export default { name, inject, apply };
