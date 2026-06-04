# Customization & Theming

Starwind components reference semantic CSS variable tokens. Change the variables in the active Starwind CSS file to change every component.

## Contents

- How it works: CSS variables -> Tailwind utilities -> components
- Color variables and Tailwind v4 token registration
- Dark mode setup
- Changing the theme
- Adding custom colors
- Border radius
- Customizing components: variants, `class`, source edits, wrappers
- Checking for updates

---

## How It Works

1. CSS variables are defined in `:root` for light mode and `.dark` for dark mode.
2. Tailwind CSS v4 maps them through `@theme inline`: `--color-primary: var(--primary)`.
3. Components use utilities like `bg-primary`, `text-muted-foreground`, `border-border`, and `outline-outline`.
4. Changing a variable changes every component that references the matching utility.

Find the active CSS file from `starwind.config.json` first, usually:

```txt
src/styles/starwind.css
```

Never create a second theme file when the project already has one.

---

## Color Variables

Starwind uses the `name` / `name-foreground` convention. The base variable is for backgrounds, fills, borders, or actions. The `-foreground` variable is for readable text/icons on that background.

| Variable                                      | Purpose                                           |
| --------------------------------------------- | ------------------------------------------------- |
| `--background` / `--foreground`               | Page background and default text                  |
| `--card` / `--card-foreground`                | Card surfaces                                     |
| `--popover` / `--popover-foreground`          | Popovers, tooltips, selects, menus                |
| `--primary` / `--primary-foreground`          | Primary buttons and actions                       |
| `--secondary` / `--secondary-foreground`      | Secondary actions                                 |
| `--primary-accent`, `--secondary-accent`      | Brand text colors readable on the page background |
| `--muted` / `--muted-foreground`              | Muted surfaces and quiet text                     |
| `--accent` / `--accent-foreground`            | Hover and selected states                         |
| `--info`, `--success`, `--warning`, `--error` | Status colors and matching foregrounds            |
| `--border`                                    | Default border color                              |
| `--input`                                     | Form input borders                                |
| `--outline`                                   | Focus outline color                               |
| `--radius`                                    | Global radius seed                                |
| `--sidebar-*`                                 | Sidebar-specific colors                           |

Default Starwind themes usually reference Tailwind CSS v4 palette variables like `var(--color-blue-700)`. OKLCH, hex, `rgb()`, and other valid CSS colors are fine when the local project already uses them.

---

## Dark Mode

Starwind uses class-based dark mode via `.dark` on the root element:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

- Do not replace Starwind's `.dark` class model with a `data-theme` system unless the app already bridges that model.
- Do not solve global theme requests by adding many component-level `dark:` color classes.
- Update `.dark` with `:root` values, and preserve existing no-flash scripts.

Use `npx starwind@latest add theme-toggle` when the user wants a managed toggle. It persists the preference, toggles `.dark`, and dispatches `theme:change`.

---

## Changing The Theme

Edit CSS variables directly in the active Starwind CSS file.

```css
:root {
  --primary: var(--color-emerald-700);
  --primary-foreground: var(--color-white);
  --primary-accent: var(--color-emerald-800);
}

.dark {
  --primary: var(--color-emerald-500);
  --primary-foreground: var(--color-neutral-950);
  --primary-accent: var(--color-emerald-300);
}
```

Then keep component usage semantic: `<Button variant="primary">Save changes</Button>`.

---

## Adding Custom Colors

Add variables to the active Starwind CSS file from `starwind.config.json`.

```css
/* 1. Register Tailwind v4 utilities. */
@theme inline {
  --color-brand: var(--brand);
  --color-brand-foreground: var(--brand-foreground);
}

/* 2. Define light and dark values. */
:root {
  --brand: var(--color-blue-700);
  --brand-foreground: var(--color-white);
}

.dark {
  --brand: var(--color-blue-500);
  --brand-foreground: var(--color-neutral-950);
}
```

```astro
<!-- 3. Use semantic utilities. -->
<div class="bg-brand text-brand-foreground">Brand surface</div>
```

Starwind is designed for Tailwind CSS v4, so use `@theme inline`; do not add Tailwind v3 `tailwind.config.js` color registration unless the local project has intentionally diverged.

---

## Border Radius

`--radius` controls border radius globally. Starwind maps it to radius utilities in `@theme inline`.

```css
:root {
  --radius: 0.625rem;
}
```

Use local classes like `class="rounded-full"` only for one-off exceptions.

---

## Customizing Components

See also: [rules/styling.md](./rules/styling.md) for incorrect/correct examples.

Prefer these approaches in order:

### 1. Built-In Variants

```astro
<Button variant="outline" size="sm">Cancel</Button>
```

Verify exact variants in current docs or local component source.

### 2. Tailwind Classes Via `class`

```astro
<Button class="w-full sm:w-auto">Continue</Button>
```

Use `class` for layout and scoped exceptions, not to recreate existing variants or theme tokens.

### 3. Add A New Variant

Edit installed component source only when variants, tokens, and `class` cannot express the change.

```ts
// components/starwind/button/variants.ts
warning: "bg-warning text-warning-foreground hover:bg-warning/90";
```

Preserve `data-slot` attributes, exports, `tailwind-variants` / `tailwind-merge` patterns, and scripts.

### 4. Wrapper Components

Compose Starwind primitives into higher-level project components when a pattern repeats:

```astro
<Dialog>
  <DialogTrigger asChild><slot name="trigger" /></DialogTrigger>
  <DialogContent>
    <slot />
    <DialogFooter>
      <Button variant="outline">Cancel</Button>
      <Button variant="primary">Confirm</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

Verify `asChild` and part names against current docs or local exports before using them.

---

## Checking For Updates

Starwind components are local source files after installation.

```bash
npx starwind@latest update button
```

`update` overwrites local component changes. Before updating customized components, check local edits, check imports, and read current docs/source.

Starwind currently documents `update`, `update --all`, `update --yes`, and `update --package-manager`.
