# Styling & Customization

See [customization.md](../customization.md) for theming, CSS variables, dark mode, and adding custom colors.

## Contents

- Semantic colors
- Status/state indicators
- Built-in variants first
- `class` for layout only
- No `space-x-*` / `space-y-*`
- Prefer `size-*`
- Prefer `truncate`
- No manual `dark:` color overrides
- Use Tailwind Variants for reusable variants
- No manual z-index on overlays

---

## Semantic Colors

Use Starwind semantic tokens. They map to CSS variables in the active Starwind CSS file and follow light/dark values.

**Incorrect:**

```astro
<p class="text-slate-500">Secondary text</p>
<section class="border-gray-200 bg-white text-gray-950">Content</section>
```

**Correct:**

```astro
<p class="text-muted-foreground">Secondary text</p>
<section class="border-border bg-background text-foreground">Content</section>
```

Common tokens include `bg-background`, `text-foreground`, `bg-card`, `text-card-foreground`, `bg-primary`, `text-primary-foreground`, `bg-muted`, `text-muted-foreground`, `border-border`, `border-input`, and `ring-outline`.

---

## Status/State Indicators

For positive, negative, warning, info, or status indicators, use component variants or semantic tokens before raw Tailwind colors.

**Incorrect:**

```astro
<span class="text-green-600">+20.1%</span>
<span class="rounded-full bg-red-100 px-2 py-0.5 text-red-700">Failed</span>
```

**Correct:**

```astro
---
import { Badge } from "@/components/starwind/badge";
---

<span class="text-success">+20.1%</span>
<Badge variant="error">Failed</Badge>
```

Use `info`, `success`, `warning`, and `error` variants when components support them. Add a custom CSS variable only when the semantic token does not exist.

---

## Built-In Variants First

Use component variants and sizes before overriding styles with utility classes.

**Incorrect:**

```astro
<Button class="border border-input bg-transparent text-foreground hover:bg-accent">
  Cancel
</Button>
```

**Correct:**

```astro
<Button variant="outline">Cancel</Button>
```

Check docs or local `variants.ts` for exact values. Common values include `default`, `primary`, `secondary`, `outline`, `ghost`, `info`, `success`, `warning`, and `error`.

---

## `class` For Layout Only

Use `class` for layout and scoped exceptions, such as `max-w-md`, `mx-auto`, `mt-4`, `grid`, `gap-4`, `size-10`, or `rounded-full`.

Do not use `class` to replace component variants, semantic colors, or theme tokens.

**Incorrect:**

```astro
<Badge class="bg-green-100 text-green-700">Active</Badge>
```

**Correct:**

```astro
<Badge variant="success">Active</Badge>
```

Preferred order: variants/props -> semantic tokens -> CSS variables -> local `class` exceptions -> component internals.

---

## No `space-x-*` / `space-y-*`

Use `gap-*` instead.

```astro
<!-- Incorrect -->
<div class="flex space-x-2">
  <Button>Cancel</Button>
  <Button>Save</Button>
</div>

<!-- Correct -->
<div class="flex gap-2">
  <Button>Cancel</Button>
  <Button>Save</Button>
</div>
```

`space-y-4` -> `flex flex-col gap-4`

---

## Prefer `size-*`

Use `size-*` when width and height are equal.

```astro
<!-- Incorrect -->
<Skeleton class="h-10 w-10 rounded-full" />

<!-- Correct -->
<Skeleton class="size-10 rounded-full" />
```

Applies to icons, avatars, skeletons, and icon buttons.

---

## Prefer `truncate`

Use `truncate`, not `overflow-hidden text-ellipsis whitespace-nowrap`.

```astro
<p class="truncate">A very long project name</p>
```

Use `line-clamp-*` or intentional wrapping for multi-line text.

---

## No Manual `dark:` Color Overrides

Starwind dark mode is class-based through `.dark`, and component colors come from CSS variables.

**Incorrect:**

```astro
<main class="bg-white text-slate-950 dark:bg-slate-950 dark:text-slate-50">
  Content
</main>
```

**Correct:**

```astro
<main class="bg-background text-foreground">
  Content
</main>
```

For global theme changes, edit `:root` and `.dark` variables in the active Starwind CSS file.

---

## Use Tailwind Variants For Conditional Classes

For conditional or merged class names, follow Starwind's component pattern and use `tailwind-variants`. Do not assume a `cn()` helper exists in Astro projects.

**Incorrect:**

```astro
<div class={`flex items-center ${isActive ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
```

**Correct:**

```ts
import { tv } from "tailwind-variants";

export const item = tv({
  base: "flex items-center",
  variants: {
    active: {
      true: "bg-primary text-primary-foreground",
      false: "bg-muted",
    },
  },
  defaultVariants: {
    active: false,
  },
});
```

```astro
<div class={item({ active: isActive })}>
```

Use this for reusable variants or component internals. For one-off layout, a plain `class` string is fine.

---

## No Manual Z-Index On Overlays

Overlay components manage their own stacking and positioning unless local docs/source show a conflict.

Do not add arbitrary z-index to `Dialog`, `Sheet`, `AlertDialog`, `Dropdown`, `ContextMenu`, `Popover`, `Tooltip`, `HoverCard`, or `SelectContent`.

If a stacking bug exists, inspect the installed component source before adding overrides.
