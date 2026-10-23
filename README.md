# opencode-claude-code

Use Claude Code's login and models in OpenCode 2. OpenCode runs tools and manages
permissions and history. Claude CLI handles authentication and model requests.
Adapted from [pi-claude-code](https://github.com/earendil-works/pi-claude-code).

Experimental.

## Requirements

- OpenCode 2.
- Claude CLI, signed in with `claude auth login`.

## Install from npm

Add the package to your OpenCode configuration, preserving existing plugins:

```json
{
  "plugins": ["@benkoppe/opencode-claude-code"]
}
```

OpenCode installs the package automatically.

## Install with Nix

The Nix package supplies its runtime.

```sh
nix build .
```

Use the absolute path to `result/lib/opencode-claude-code` in your plugin list.
Keep the `result` symlink as a GC root. Claude CLI is installed separately.

For a declarative setup, add this flake input:

```nix
inputs.opencode-claude-code.url = "github:benkoppe/opencode-claude-code";
```

Then, add this entry in the Nix expression that generates your OpenCode JSON:

```nix
plugins = [
	"${inputs.opencode-claude-code.packages.${pkgs.stdenv.hostPlatform.system}.default}/lib/opencode-claude-code"
];
```

## Usage

Models from this plugin are labeled under **Claude Code**.

Optionally, set `"model": "claude-code/opus"`, or another model, to change Opencode's default.

If the **Claude Code** label is missing, sign into Claude Code with `claude auth login`,
then reload OpenCode with `opencode service restart`.

Optional executable and directory options are `claudeCommand`, `configDir`, and `nodeCommand`.
Use the object form, for example:

```json
{
  "plugins": [
    {
      "package": "/path/to/dist",
      "options": {
        "claudeCommand": "/path/to/claude",
        "allowUsageCredits": false
      }
    }
  ]
}
```

Environment equivalents are `OPENCODE_CLAUDE_CODE_COMMAND`,
`OPENCODE_CLAUDE_CODE_CONFIG_DIR`, and `OPENCODE_CLAUDE_CODE_NODE_COMMAND`.

To hide the built-in Anthropic provider, append this OpenCode policy:

```json
{
  "policies": [
    { "action": "provider.use", "resource": "anthropic", "effect": "deny" }
  ]
}
```

## Billing and limits

The plugin, by default, stops when Claude reports charging paid usage credits
instead of your subscription allowance. This doesn't work for already in-flight
requests, however. To strictly prevent credit spending, disable usage credits in
your Claude account settings.

To let the plugin continue using paid credits, add `"allowUsageCredits": true`
to the plugin's `options` object above. This does not enable credits in your
Claude account. The environment variable alternative for this is
`OPENCODE_CLAUDE_CODE_ALLOW_USAGE_CREDITS`.

Unset Claude API-key, custom-endpoint, and cloud-backend environment variables
before using this plugin. It uses your Claude Code login instead.

## Install from source

Requires Node.js and pnpm.

Clone this repository, enter its directory, and build:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Append the absolute `dist` path to `~/.config/opencode/opencode.json`, or your
project's `opencode.json`. Preserve existing plugins.

```json
{
  "plugins": ["/absolute/path/to/opencode-claude-code/dist"]
}
```

Rebuild after source updates.

## Development

```sh
pnpm check
pnpm test
pnpm build
pnpm smoke   # Uses your Claude login and subscription quota.
pnpm release:check "$PWD/dist"  # Live compaction, restart, tools, and cache checks.
```

For a fixture-only tool round:

```sh
OPENCODE_CLAUDE_CODE_COMMAND="$PWD/tests/fake-claude.mjs" FAKE_TOOL_ROUND=1 pnpm smoke
```

Pass a plugin directory to `pnpm smoke` to test a packaged build. Set
`OPENCODE_COMMAND` if needed. Smoke tests isolate OpenCode data under
`/tmp/opencode` and retain the directory for inspection.

`pnpm pack` checks, tests, and rebuilds before creating a tarball. With Nix
installed, `nix build .` also runs checks.
