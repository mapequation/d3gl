# Component Composition

Compose Starwind UI from installed Astro components. Prefer documented parts and variants over handwritten markup that imitates rendered output.

## Contents

- Use components instead of custom markup
- Grouped items stay inside group components
- Toast notifications use `toast`
- Choose the right overlay component
- Dialog, Sheet, and AlertDialog need a title
- Button has no `isPending` or `isLoading` prop
- Card structure
- Select and Combobox
- TabsTrigger belongs inside TabsList
- Avatar always needs AvatarFallback
- Loading, status, and divider primitives

## General Rules

- Import from `@/components/starwind/<component-name>` unless the project alias or `starwind.config.json` says otherwise.
- Use Astro attributes: `class`, `for`, `tabindex`, `readonly`, and plain browser scripts.
- Read local exports before assuming part names. Starwind is Astro-first; do not copy shadcn React-only helpers into `.astro` files.
- Preserve `data-slot` attributes and Starwind class hooks when editing installed component internals.

## Use Components, Not Custom Markup

| Instead of | Use |
| --- | --- |
| Custom callout `div` | `alert` |
| Custom status pill/span | `badge` |
| Raw `hr` or border-only divider | `separator` |
| Custom loading pulse block | `skeleton` |
| Inline spinner markup | `spinner` |
| Hand-rolled toast stack | `toast` with one `Toaster` |
| Generic bordered section | `card` or `item` when the structure matches |
| Manually joined buttons | `button-group` |

Starwind does not currently document a standalone `empty` component. For empty states, compose semantic app markup with `Card`, `Item`, `Button`, icons, and text.

## Grouped Items

Use group wrappers when a component provides them.

| Items | Group |
| --- | --- |
| `SelectItem`, `SelectLabel`, `SelectSeparator` | `SelectGroup` |
| `Item` | `ItemGroup` |
| `Button` clusters | `ButtonGroup` |
| `InputOtpSlot` | `InputOtpGroup` |
| `Kbd` combinations | `KbdGroup` |

For Dropdown and Context Menu grouping, labels, shortcuts, checkboxes, and submenus, confirm exact names from current docs or local exports.

## Toast Notifications

Use Starwind's `toast` component. Add `Toaster` once in a shared layout:

```astro
---
import { Toaster } from "@/components/starwind/toast";
---

<body>
  <slot />
  <Toaster position="bottom-right" />
</body>
```

Trigger toasts from Astro scripts:

```astro
---
import { Button } from "@/components/starwind/button";
---

<Button id="save-profile">Save profile</Button>

<script>
  import { toast } from "@/components/starwind/toast";

  document.getElementById("save-profile")?.addEventListener("click", () => {
    toast.success("Saved successfully", {
      description: "Your profile changes are live.",
    });
  });
</script>
```

Useful APIs: `toast()`, `toast.success()`, `toast.error()`, `toast.warning()`, `toast.info()`, `toast.loading()`, `toast.promise()`, `toast.update()`, and `toast.dismiss()`. `Toaster` props include `position`, `limit`, `duration`, `gap`, and `peek`.

## Choosing Between Overlay Components

| Use case | Component |
| --- | --- |
| Focused modal task that requires input | `dialog` |
| Destructive or irreversible confirmation | `alert-dialog` |
| Side panel with details, filters, or navigation | `sheet` |
| Mobile-first bottom panel | `sheet` with `SheetContent side="bottom"` |
| Menu of actions from a button | `dropdown` |
| Right-click or long-press menu | `context-menu` |
| Small contextual content opened by click | `popover` |
| Rich preview on hover | `hover-card` |
| Short helper text on hover/focus | `tooltip` |
| Choosing from a list of values | `select` or `native-select` |

A tooltip is not an interactive panel, a popover is not a destructive confirmation, and a dropdown is not a form select.

## Dialog, Sheet, And AlertDialog Need Titles

`DialogTitle`, `SheetTitle`, and `AlertDialogTitle` are required for accessible names. Use `class="sr-only"` if visually hidden.

```astro
---
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/starwind/dialog";
import { Button } from "@/components/starwind/button";
---

<Dialog>
  <DialogTrigger asChild>
    <Button>Edit profile</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Edit profile</DialogTitle>
    </DialogHeader>
    <!-- content -->
  </DialogContent>
</Dialog>
```

For destructive confirmations, prefer `alert-dialog` with `AlertDialogCancel` and `AlertDialogAction`.

## Button Has No isPending Or isLoading Prop

Starwind `Button` does not document `isPending` or `isLoading`. Compose loading state with `Spinner`, `disabled`, and `aria-busy`:

```astro
---
import { Button } from "@/components/starwind/button";
import { Spinner } from "@/components/starwind/spinner";
---

<Button disabled aria-busy="true">
  <Spinner />
  Saving...
</Button>
```

For icon-only buttons, use documented icon sizes (`icon`, `icon-sm`, `icon-lg`) and provide an accessible name.

## Card Structure

Use full Card composition. Do not dump everything into `CardContent`.

```astro
---
import { Button } from "@/components/starwind/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/starwind/card";
---

<Card>
  <CardHeader>
    <CardTitle>Project settings</CardTitle>
    <CardDescription>Manage defaults for new workspaces.</CardDescription>
    <CardAction>
      <Button variant="outline" size="sm">Edit</Button>
    </CardAction>
  </CardHeader>
  <CardContent><!-- content --></CardContent>
  <CardFooter><!-- actions --></CardFooter>
</Card>
```

## Select And Combobox

Combobox behavior is a `select` component pattern. Install `select`, then use `SelectSearch` inside `SelectContent`. Do not run `starwind add combobox`.

```astro
---
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSearch,
  SelectTrigger,
  SelectValue,
} from "@/components/starwind/select";
---

<Select name="framework">
  <SelectTrigger>
    <SelectValue placeholder="Select a framework" />
  </SelectTrigger>
  <SelectContent>
    <SelectSearch placeholder="Search frameworks..." emptyText="No frameworks found." />
    <SelectGroup>
      <SelectItem value="astro">Astro</SelectItem>
      <SelectItem value="svelte">Svelte</SelectItem>
    </SelectGroup>
  </SelectContent>
</Select>
```

Set `name` for form submission. Listen for `starwind-select:change` when client behavior needs the selected value.

## TabsTrigger Must Be Inside TabsList

Never render `TabsTrigger` directly inside `Tabs`; wrap triggers in `TabsList` and match values with `TabsContent`.

```astro
---
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/starwind/tabs";
---

<Tabs defaultValue="overview">
  <TabsList>
    <TabsTrigger value="overview">Overview</TabsTrigger>
    <TabsTrigger value="activity">Activity</TabsTrigger>
  </TabsList>
  <TabsContent value="overview">Overview content</TabsContent>
  <TabsContent value="activity">Activity content</TabsContent>
</Tabs>
```

## Avatar Always Needs AvatarFallback

```astro
---
import { Avatar, AvatarFallback, AvatarImage } from "@/components/starwind/avatar";
---

<Avatar>
  <AvatarImage src="/avatars/jane.jpg" alt="Jane Doe" />
  <AvatarFallback>JD</AvatarFallback>
</Avatar>
```

## Loading, Status, And Divider Primitives

- Use `Skeleton` for loading placeholders.
- Use `Spinner` for active progress.
- Use `Badge` for status labels.
- Use `Alert` for callouts.
- Use `Separator` instead of raw `hr` or border-only dividers.

Keep examples brief in this file. For exact props, events, variants, and subcomponent names, read current Starwind docs or the installed component source before editing.
