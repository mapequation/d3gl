# Forms And Inputs

Use Starwind form components as Astro components and preserve native form semantics.

Starwind does not use shadcn's React `FieldGroup`/`Field` form API. In Astro, use semantic form markup, the Starwind control components, `label`, and native ARIA attributes.

## Labels

Install and use `label` when building labeled controls.

```astro
---
import { Input } from "@/components/starwind/input";
import { Label } from "@/components/starwind/label";
---

<div class="grid gap-2">
  <Label for="email">Email</Label>
  <Input id="email" name="email" type="email" autocomplete="email" required />
</div>
```

Rules:

- Use `for` in Astro, not `htmlFor`.
- Match `Label for` to the control `id`.
- Preserve `name` on form controls that should submit.
- Use `required`, `disabled`, `readonly`, `aria-invalid`, and `aria-describedby` as native attributes where appropriate.

## Input Group

Use `input-group` for prefix/suffix text, icons, actions, and textarea addons.

```astro
---
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/starwind/input-group";
---

<InputGroup>
  <InputGroupInput name="site" placeholder="example.com" />
  <InputGroupAddon align="inline-start">
    <InputGroupText>https://</InputGroupText>
  </InputGroupAddon>
  <InputGroupAddon align="inline-end">
    <InputGroupButton size="sm" variant="outline">Check</InputGroupButton>
  </InputGroupAddon>
</InputGroup>
```

Rules:

- Use `InputGroupInput` or `InputGroupTextarea` inside `InputGroup`, not raw `Input` or `Textarea`.
- Use `InputGroupAddon` for icons, text, buttons, and block labels.
- `InputGroupAddon` alignment values include `inline-start`, `inline-end`, `block-start`, and `block-end`.
- Place `InputGroupAddon` after the control in the DOM for proper focus behavior, even when its visual alignment is `inline-start`.
- Use `inline-*` alignments with `InputGroupInput`; use `block-*` alignments with `InputGroupTextarea`.
- Use `InputGroupButton` for actions inside the group.

## Choosing Controls

- Simple text input: `input`
- Multi-line text: `textarea`
- Prefix/suffix/action input: `input-group`
- Custom dropdown: `select`
- Searchable dropdown or combobox: `select` with `SelectSearch`
- Browser-native dropdown: `native-select`
- Boolean setting: `switch`
- Form checkbox: `checkbox`
- Single choice from several options: `radio-group`
- Two-state pressed action: `toggle`
- One-time code: `input-otp`

## Select

Use `select` for custom select UI and `native-select` when browser-native select behavior is preferred.

For custom Select:

- Set `name` on `Select` for form submission.
- Use `defaultValue` for initial selection.
- Use `SelectSearch` for searchable/Combobox-style lists.
- Listen for `starwind-select:change` when client behavior needs the selected value.

## Validation

- Pair error text with `aria-describedby`.
- Set `aria-invalid="true"` on invalid controls.
- Keep error text near the field it describes.
- Do not rely on color alone to communicate invalid state.
- Keep disabled and required state on the actual form control, not only on wrapper elements.
