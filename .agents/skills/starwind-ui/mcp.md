# Starwind MCP Server

The published Starwind MCP server lets AI assistants fetch live Starwind docs, generate validated CLI commands, and search Starwind Pro blocks.

---

## Setup

The MCP package is `@starwind-ui/mcp`.

```bash
npx -y @starwind-ui/mcp
```

Common client config files:

| Client      | Config file            |
| ----------- | ---------------------- |
| Codex       | `~/.codex/config.toml` |
| Claude Code | `.mcp.json`            |
| Cursor      | `.cursor/mcp.json`     |
| VS Code     | `.vscode/mcp.json`     |
| opencode    | `opencode.json`        |
| Windsurf    | `mcp_config.json`      |

---

## Tools

> **Tip:** MCP tools handle live Starwind docs, validated install command generation, and Starwind Pro block search. They do not replace local project inspection. Read `package.json`, lockfiles, Astro config, `starwind.config.json`, the active Starwind CSS file, and installed component source for project context.

### `starwind_docs`

Fetches live Starwind UI documentation from `starwind.dev`.

**Input:**

| Field   | Type               | Notes                                                                              |
| ------- | ------------------ | ---------------------------------------------------------------------------------- |
| `topic` | `string` optional  | Filter docs, such as `button`, `cli`, `ai`, `theming`, `installation`, or `select` |
| `full`  | `boolean` optional | `true` returns fuller docs with more examples; default is concise                  |

**Examples:**

```json
{ "topic": "button", "full": false }
{ "topic": "cli", "full": true }
{ "topic": "ai", "full": true }
```

Use this before implementing component props, custom events, theme behavior, or setup instructions.

### `starwind_add`

Generates validated CLI install commands for Starwind components and Pro blocks. It validates component names and can detect or accept a package manager.

**Input:**

| Field            | Type                                 | Notes                                                                |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `components`     | `string[]` required                  | Component names, Pro block names, or `["--all"]`                     |
| `cwd`            | `string` optional                    | Working directory for package-manager detection                      |
| `packageManager` | `"npm" \| "pnpm" \| "yarn"` optional | Override detection                                                   |
| `init`           | `boolean` optional                   | Include an init command for new projects                             |
| `pro`            | `boolean` optional                   | Generate Pro-aware setup; auto-detected for `@starwind-pro/*` blocks |

**Examples:**

```json
{ "components": ["button", "select"], "packageManager": "pnpm" }
{ "components": ["--all"], "packageManager": "npm" }
{ "components": ["@starwind-pro/hero-01", "button"], "init": true, "pro": true }
```

Rules:

- Use this after checking docs or search results so you know which components to install.
- Do not remove dependencies from generated Pro block commands.
- Even when the tool returns a command, still run it from the user's project root and read added files afterward.

### `starwind_init`

Generates initialization guidance for Starwind UI projects.

**Input:**

| Field            | Type                                 | Notes                                                                           |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `cwd`            | `string` optional                    | Working directory for package-manager detection                                 |
| `packageManager` | `"npm" \| "pnpm" \| "yarn"` optional | Override detection                                                              |
| `pro`            | `boolean` optional                   | Defaults to Pro setup in the MCP tool; set `false` only for standard-only setup |

**Examples:**

```json
{ "packageManager": "pnpm", "pro": false }
{ "packageManager": "pnpm", "pro": true }
```

Rules:

- Use Pro initialization when the user wants Starwind Pro blocks from the start.
- For standard-only Starwind UI, set `pro: false`.
- Treat generated commands as guidance; run them only in the intended user project.

### `search_starwind_pro_blocks`

Searches Starwind Pro blocks by query, category, and plan type.

**Input:**

| Field      | Type                       | Notes                                                                                   |
| ---------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `query`    | `string` optional          | Text search, such as `hero`, `pricing`, or `auth`                                       |
| `category` | `string` optional          | Filter by category, such as `hero`, `pricing`, `footer`, `navigation`, `authentication` |
| `plan`     | `"free" \| "pro"` optional | Filter by free or paid blocks                                                           |
| `limit`    | `number` optional          | Default `10`, max `50`                                                                  |

**Examples:**

```json
{ "query": "hero", "plan": "free", "limit": 2 }
{ "category": "pricing", "plan": "pro", "limit": 10 }
```

Rules:

- Use returned `installCommand` exactly unless the package runner must be adapted to the project.
- Paid blocks may require a Starwind Pro license.
- Pro blocks require Pro setup. The tool may report an init/setup command and requirements.

---

## Public AI Files

Use these when MCP is unavailable or when static docs are enough:

- `https://starwind.dev/llms.txt` - concise AI overview
- `https://starwind.dev/llms-full.txt` - full static reference
- `https://starwind.dev/ai-manifest.json` - structured component, pattern, and guide metadata
- Per-page Markdown docs - append `.md` to a docs route, such as `https://starwind.dev/docs/components/button.md`

HTML docs pages include a Markdown alternate link. Prefer the advertised Markdown URL when available.

---

## Source Priority

Use this order when facts differ:

1. Local project files and installed Starwind component source.
2. Current MCP tool responses.
3. Current Starwind docs Markdown pages and AI files.
4. CLI output from the local `starwind` package.
5. General memory.

---

## Verification Checklist

Before implementing Starwind UI changes:

- Confirm the project is Astro and uses Tailwind CSS v4.
- Confirm `starwind.config.json`, `tailwind.css`, and `componentDir`.
- Confirm installed components and local exports before importing.
- Use `starwind_docs` or docs Markdown for props, events, and composition.
- Use `starwind_add` for install command generation when available.
- Use `search_starwind_pro_blocks` before choosing a Pro block.
- After adding files, read them and fix alias drift, icon imports, missing subcomponents, and Astro syntax issues.
