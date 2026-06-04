# Starwind CLI Reference

Starwind project configuration is read from `starwind.config.json`. Starwind Pro setup may also configure registry details in `components.json`.

> **IMPORTANT:** Run commands from the user's project root. Examples below use `npx starwind@latest`, but substitute the project's package runner when it is clear: `npx starwind@latest`, `pnpx starwind@latest` / `pnpm dlx starwind@latest`, or `yarn dlx starwind@latest`.

> **IMPORTANT:** Only use the flags documented below. Do not borrow shadcn CLI flags or invent any other flags unless they are listed here.

## Contents

- Commands: `init`, `add`, `update`, `search`, `docs`, `setup`, `remove`
- Package runners and package-manager flags
- Missing shadcn CLI features

---

## Commands

### `init` - Initialize Starwind UI

```bash
npx starwind@latest init [options]
```

Initializes project configuration, creates `starwind.config.json`, installs dependencies, sets up the Tailwind CSS file, configures aliases, updates Astro configuration, and adds the CSS import to the layout when possible.

| Flag         | Short | Description                        | Default |
| ------------ | ----- | ---------------------------------- | ------- |
| `--defaults` | `-d`  | Use default values for all prompts | `false` |
| `--pro`      | `-p`  | Initialize with Starwind Pro setup | `false` |
| `--help`     | `-h`  | Display help                       | -       |

Examples:

```bash
npx starwind@latest init
npx starwind@latest init --defaults
npx starwind@latest init --pro
```

Notes:

- Use `init` before adding components in a project that has not been configured for Starwind.
- `init` prompts for component directory, Tailwind CSS file location, base color, package manager, and dependency installation unless `--defaults` is used.
- Use `init --pro` for a new project that should support Starwind Pro from the start.

### `add` - Add components or Pro blocks

```bash
npx starwind@latest add [components...] [options]
```

Adds Starwind components to the project. If no components are provided, the CLI opens an interactive component picker.

| Argument        | Description                                         |
| --------------- | --------------------------------------------------- |
| `components...` | Component names or Pro block names, space separated |

| Flag                     | Short | Description                                      | Default           |
| ------------------------ | ----- | ------------------------------------------------ | ----------------- |
| `--all`                  | `-a`  | Add all available components                     | `false`           |
| `--yes`                  | `-y`  | Skip confirmation prompts                        | `false`           |
| `--package-manager <pm>` | `-m`  | Package manager to use: `npm`, `pnpm`, or `yarn` | detected/prompted |
| `--help`                 | `-h`  | Display help                                     | -                 |

Examples:

```bash
npx starwind@latest add button
npx starwind@latest add button card select
npx starwind@latest add --all
npx starwind@latest add button --yes
npx starwind@latest add button --package-manager pnpm
npx starwind@latest add @starwind-pro/hero-01 button
```

Rules:

- Component names are registry names, such as `button`, `card`, `select`, `input-group`, `kbd`, and `theme-toggle`.
- `combobox` is not an installable component. Use `select` with `SelectSearch`.
- The CLI resolves Starwind component dependencies and shared file dependencies.
- After adding, read the added files before using them. Verify imports, exports, Astro syntax, icon imports, and initialized scripts.
- Use the exact Pro block install command returned by `search`, MCP, manifest, or current docs. Do not remove dependencies from returned commands.

### `update` - Update installed components

```bash
npx starwind@latest update [components...] [options]
```

Updates Starwind components to their latest versions.

> **CAUTION:** `update` overwrites local component changes.

If no components are provided, the CLI opens an interactive picker for installed components.

| Argument        | Description                           |
| --------------- | ------------------------------------- |
| `components...` | Components to update, space separated |

| Flag                     | Short | Description                                      | Default           |
| ------------------------ | ----- | ------------------------------------------------ | ----------------- |
| `--all`                  | `-a`  | Update all installed components                  | `false`           |
| `--yes`                  | `-y`  | Skip confirmation prompts                        | `false`           |
| `--package-manager <pm>` | `-m`  | Package manager to use: `npm`, `pnpm`, or `yarn` | detected/prompted |
| `--help`                 | `-h`  | Display help                                     | -                 |

Examples:

```bash
npx starwind@latest update button
npx starwind@latest update button card --yes
npx starwind@latest update --all
```

Rules:

- Only update when the user asks for an update or accepts overwrite risk.
- Check whether the component has local edits before updating.
- Use `--all` only when the user explicitly wants all components updated.
- Starwind does not document `--dry-run`, `--diff`, or `--view`; do not invent preview commands. For review, inspect local files and current docs/source manually.

### `search` - Search components and Pro blocks

```bash
npx starwind@latest search [query] [options]
```

Searches Starwind components and Starwind Pro blocks. Use this when a component or block name is uncertain.

| Argument | Description         |
| -------- | ------------------- |
| `query`  | Search query string |

| Flag                    | Short | Description                                | Default |
| ----------------------- | ----- | ------------------------------------------ | ------- |
| `--plan <plan>`         | `-p`  | Filter Pro blocks by plan: `free` or `pro` | -       |
| `--category <category>` | `-c`  | Filter Pro blocks by category              | -       |
| `--limit <number>`      | `-l`  | Maximum number of Pro blocks to display    | `"20"`  |
| `--offset <number>`     | `-o`  | Offset for paginating Pro block results    | `"0"`   |
| `--json`                | -     | Output as JSON                             | `false` |
| `--help`                | `-h`  | Display help                               | -       |

Examples:

```bash
npx starwind@latest search select
npx starwind@latest search hero --json
npx starwind@latest search pricing --plan free --category pricing --limit 10 --json
```

Rules:

- Use `--json` when another tool or script needs structured results.
- Plan and category filters are mainly for Pro block searches.
- Search results for Pro blocks can include exact install commands. Use them as returned.
- Pro blocks may require `npx starwind@latest setup` before installation.

### `docs` - Get component documentation references

```bash
npx starwind@latest docs [components...] [options]
```

Returns documentation references for one or more components. Fetch the referenced docs or Markdown content before implementing props, events, or composition.

| Argument        | Description                            |
| --------------- | -------------------------------------- |
| `components...` | Components to look up, space separated |

| Flag     | Short | Description    | Default |
| -------- | ----- | -------------- | ------- |
| `--json` | -     | Output as JSON | `false` |
| `--help` | `-h`  | Display help   | -       |

Examples:

```bash
npx starwind@latest docs button
npx starwind@latest docs button card --json
```

Rules:

- Use this to confirm component names and docs URLs.
- Do not stop at a URL list. Read the docs content before coding.
- Prefer the docs page's linked Markdown alternate when raw documentation is needed.

### `setup` - Configure Starwind Pro

```bash
npx starwind@latest setup [options]
```

Sets up Starwind Pro in an already initialized Starwind UI project.

| Flag                     | Short | Description                                      | Default           |
| ------------------------ | ----- | ------------------------------------------------ | ----------------- |
| `--yes`                  | `-y`  | Skip confirmation prompts                        | `false`           |
| `--package-manager <pm>` | `-m`  | Package manager to use: `npm`, `pnpm`, or `yarn` | detected/prompted |
| `--pro`                  | `-p`  | Setup Starwind Pro                               | `true`            |
| `--help`                 | `-h`  | Display help                                     | -                 |

Examples:

```bash
npx starwind@latest setup
npx starwind@latest setup --yes
npx starwind@latest setup --package-manager pnpm
```

Rules:

- Use `setup` for existing Starwind UI projects that need Pro block support.
- Do not place license secrets in source files.
- Setup may create `.env.local`, update `.gitignore`, and configure Pro registry details.
- If `.env.local` is created, confirm it is ignored by git.

### `remove` - Remove components

```bash
npx starwind@latest remove [components...] [options]
```

Removes Starwind components from the project. If no components are provided, the CLI opens an interactive picker.

| Argument        | Description                           |
| --------------- | ------------------------------------- |
| `components...` | Components to remove, space separated |

| Flag     | Short | Description                     | Default |
| -------- | ----- | ------------------------------- | ------- |
| `--all`  | `-a`  | Remove all installed components | `false` |
| `--help` | `-h`  | Display help                    | -       |

Examples:

```bash
npx starwind@latest remove button
npx starwind@latest remove button card
npx starwind@latest remove --all
```

Rules:

- Remove only components that are no longer imported.
- Search local imports before removing.
- Use `--all` only when the user explicitly wants to remove every installed component.

---

## Package Runners

| Package manager | Runner                                               |
| --------------- | ---------------------------------------------------- |
| npm             | `npx starwind@latest`                                |
| pnpm            | `pnpx starwind@latest` or `pnpm dlx starwind@latest` |
| yarn            | `yarn dlx starwind@latest`                           |

Use the package manager indicated by `package.json`, lockfiles, or user instruction. For commands that document `--package-manager`, pass `npm`, `pnpm`, or `yarn` only when the local choice is clear or package-manager detection needs help.

## Missing shadcn CLI Features

Starwind's CLI is intentionally smaller than shadcn's. Do not use these shadcn commands or flags unless Starwind documents them later:

- Commands: `apply`, `view`, `info`, `build`, `create`, `list`, `diff`
- Flags: `--cwd`, `--silent`, `--path`, `--overwrite`, `--force`, `--dry-run`, `--diff`, `--view`, `--template`, `--preset`, `--name`, `--reinstall`, `--monorepo`, `--no-monorepo`
- Concepts: shadcn templates, shadcn presets, shadcn smart merge, registry item URLs or local registry paths accepted by `add`

Fallbacks:

- For project info, read `package.json`, lockfiles, Astro config, `starwind.config.json`, the Starwind CSS file, and installed component source.
- For docs, use Starwind MCP, `npx starwind@latest docs <component> --json`, Starwind Markdown docs, and local installed source.
- For update previews, inspect local component files and current docs/source manually; do not claim the CLI can show a dry-run or diff.
