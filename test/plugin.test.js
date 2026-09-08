import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, name } from '../lib/index.js';

test('plugin registers one routed GUI tool and one system policy section', () => {
  const tools = [];
  const sections = [];
  const effects = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => tools.splice(tools.indexOf(definition), 1);
      },
    },
    systemPrompt: {
      getSectionOrder() { return 100; },
      section(value) { sections.push(value); },
    },
    subprocess: {},
    effect(fn) { effects.push(fn); },
  };

  apply(ctx, { codexPath: '/tmp/codex', timeoutMs: 30_000 });
  assert.equal(name, 'dsh-codex-computer-use');
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'subprocess']);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'codex_computer_use');
  assert.match(tools[0].description, /macOS GUI/);
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /codex_computer_use/);
  assert.equal(effects.length, 1);
});
