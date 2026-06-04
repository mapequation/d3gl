# Icons

Starwind examples use SVG icon components, commonly from `@tabler/icons` in Astro projects. Prefer the icon system already installed in the project.

Check `package.json`, existing imports, and nearby components before adding an icon dependency. Do not assume the project uses Tabler just because the docs do.

## Astro Icon Imports

Use Astro SVG imports when available:

```astro
---
import Mail from "@tabler/icons/outline/mail.svg";
import { Button } from "@/components/starwind/button";
---

<Button>
  <Mail />
  Login with Email
</Button>
```

## Icon Buttons

Use the documented button icon sizes.

```astro
---
import Search from "@tabler/icons/outline/search.svg";
import { Button } from "@/components/starwind/button";
---

<Button size="icon" aria-label="Search">
  <Search />
</Button>
```

Rules:

- Use the documented button icon size for icon-only buttons, commonly `size="icon"`.
- Add `aria-label` or visible text for icon-only controls.
- Do not import React icon packages in a plain Astro component unless the project uses a React island for that component.
- Avoid inline SVG when a project icon package already provides the icon.
- Let Starwind component CSS size common SVG children unless a specific icon needs a documented override.
- Do not use shadcn's `data-icon` convention unless a local Starwind component explicitly documents it.
- When added blocks import a different icon package, switch them to the project's existing icon library when practical.
