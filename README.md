# dsh-codex-computer-use

A local **DeepSeek Harness native tool** that routes macOS desktop tasks through the installed Codex Computer Use runtime.

This project is intentionally different from a direct Sky MCP bridge:

```text
DSH model → codex_computer_use → Codex CLI → Codex Computer Use → macOS GUI
```

The tool is public; credentials, local paths, session data, screenshots, and logs are never part of the repository.

## Why this exists

`SkyComputerUseClient mcp` validates its parent process as an OpenAI-signed host. A DSH Node process is not that host, so direct DSH-to-Sky calls can register tools but time out at execution. This plugin keeps the supported Codex host in charge of Computer Use and exposes one narrow DSH tool for routing.

## Behavior

The plugin registers `codex_computer_use` and adds a system-prompt routing rule:

- GUI tasks go to Codex Computer Use without requiring the user to repeat a special instruction.
- The wrapper invokes a fixed executable with an argv array; task text is sent through stdin, never interpolated into a shell command.
- Codex runs with `--sandbox read-only`, `--disable shell_tool`, and `--disable unified_exec`.
- Direct `node_repl` and direct `computer-use` MCP entries are disabled for the child invocation.
- JSONL events are audited. Any shell/command-execution event or non-allowlisted MCP tool terminates the Codex process tree.
- Only a bounded final result and short event audit are returned to DSH; raw screenshots, tool arguments, and JSONL are not returned.
- The tool observes the DSH cancellation signal and applies an outer wall-clock timeout.

The wrapper allows the Codex-bundled `cua_repl/js` surface because that is the current Codex Computer Use route on this machine. That surface remains a privileged Codex capability; the wrapper does not claim that JavaScript is a general security sandbox.

## Requirements

- macOS with Codex CLI installed;
- a logged-in ChatGPT/Codex account eligible for Computer Use;
- DSH `0.1.2-rc.1` or compatible;
- DSH composition providing `ctx.tools`, `ctx.systemPrompt`, and `ctx.subprocess`;
- Codex Computer Use Accessibility and Screen Recording permissions.

## Local development

```sh
npm install
npm test
npm run check
```

## DSH profile integration

When installed as a DSH package, the bundled `cordis.patch.yml` mounts the tool automatically. For a local checkout, add an entry to the Web profile patch (adjust absolute paths):

```yaml
- insert:
    - id: dsh-codex-computer-use
      name: /absolute/path/to/dsh-codex-computer-use/lib/index.js
      config:
        codexPath: /Applications/ChatGPT.app/Contents/Resources/codex
        timeoutMs: 120000
        maxOutputBytes: 1048576
```

The host profile used for development has `dsh.profile.patchReload: live`, so a valid patch change can reload the entry without restarting DSH. A host without live patch reload must be restarted by its operator; this project never restarts a host implicitly.

## Security boundary

This is a routing and process-control wrapper, not a new Computer Use implementation. It does not read or return credentials, does not accept an arbitrary executable, does not expose a generic shell tool, and does not enable Codex's dangerous bypass flags. Do not add `.codex`, `.dsh`, auth files, screenshots, or environment files to this repository.

Before using it for destructive GUI actions, keep the normal Codex/macOS permission and approval controls in place. The wrapper's shell-event guard is defense in depth, not a substitute for OS permissions or Codex authorization.

## License

MIT. See [LICENSE](./LICENSE).
