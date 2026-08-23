# SPO Design System

A portable UI/UX specification for the suite of SPO applications, extracted from the
DonorCRM frontend (`frontend/src`). Copy this file into any new SPO app and build against it
so every app in the suite reads as the same product family.

**Reference implementation:** `betterportion/DonorCRM-SPO` → `frontend/`
**Live styleguide page:** `frontend/src/pages/Styleguide.tsx` (route `/styleguide`)

---

## 0. The five rules that make it look like SPO

If you remember nothing else, these are the choices that distinguish this system from a
default shadcn/Tailwind app. Break these and the app stops matching the suite.

1. **Primary CTAs are outlined, not solid.** White background, 2px red border, red text.
   Solid red only on hover. Solid red as a resting state is reserved for destructive actions.
2. **Body text is navy, not black.** `--foreground` is SPO Blue (`#394D74`) in light mode.
   Nothing in light mode is `#000`.
3. **Cards use borders, not shadows.** `rounded-lg border border-border`. No `shadow-*`
   on content surfaces. Shadows appear only on floating layers (popovers, toasts, sheets).
4. **12px radius everywhere. Never pills.** `--radius: 0.75rem`. No `rounded-full` on
   buttons or inputs — only on avatars and status dots.
5. **Sections breathe.** `Section` (`py-12 md:py-16`) wrapping `Container` (`max-w-7xl`)
   wrapping `space-y-6`. Dense dashboards are the exception, not the default.

---

## 1. Adopting this in a new app

Target stack (matches DonorCRM, keeps components portable between apps):

| Layer | Choice |
|---|---|
| Framework | React 19 + TypeScript + Vite |
| Styling | Tailwind CSS 3.4 (**not** v4 — token syntax below is v3) |
| Components | shadcn/ui on Radix primitives |
| Icons | `lucide-react` |
| Charts | `recharts` |
| Toasts | `sonner` |
| Tables | `@tanstack/react-table` |
| Server state | `@tanstack/react-query` v5 |
| URL state | `nuqs` |
| Class merge | `clsx` + `tailwind-merge` via `cn()` |
| Variants | `class-variance-authority` |

Setup order:

1. `npm create vite@latest -- --template react-ts`
2. Install Tailwind 3.4 + `tailwindcss-animate`, then shadcn/ui.
3. Copy **§10 Starter files** verbatim: `globals.css`, `tailwind.config.js`, `lib/utils.ts`,
   the theme bootstrap `<script>` in `index.html`.
4. Copy `components/ui/button.tsx`, `card.tsx`, `badge.tsx`, `input.tsx` from DonorCRM —
   these carry the SPO overrides, not stock shadcn defaults.
5. Copy `components/layout/{Container,Section,AppLayout,Header,Sidebar}.tsx` and swap the
   nav items.
6. Copy `providers/ThemeProvider.tsx`, changing the storage key to `<app>-theme`.

---

## 2. Color

### 2.1 Brand palette

Three brand colors. Everything else is derived neutral.

| Name | Hex | Role |
|---|---|---|
| SPO Blue | `#3A4D75` | Text, focus rings, primary chart series, structure |
| SPO Red | `#D74F59` | Accent, destructive, secondary chart series |
| SPO White | `#FFFFFF` | Light-mode surface |

Available as Tailwind utilities: `bg-spo-blue`, `text-spo-red`, `border-spo-blue`.
Use these **only** for brand-literal moments (logos, marketing). Everywhere in the app
UI, use the semantic tokens below so dark mode works.

### 2.2 Semantic tokens — light mode

HSL is the source of truth (CSS variables hold bare HSL triplets, consumed as
`hsl(var(--token))`). Hex column is the computed render value.

| Token | HSL | Hex | Use |
|---|---|---|---|
| `--background` | `0 0% 100%` | `#FFFFFF` | Page background |
| `--foreground` | `220 34% 34%` | `#394D74` | **Body text — navy, not black** |
| `--card` | `0 0% 100%` | `#FFFFFF` | Card surface |
| `--card-foreground` | `220 34% 34%` | `#394D74` | Card text |
| `--popover` / `--popover-foreground` | same as card | | Floating surfaces |
| `--primary` | `348 85% 61%` | `#F04769` | CTA red — borders, fills, links |
| `--primary-foreground` | `0 0% 100%` | `#FFFFFF` | Text on primary fill |
| `--secondary` | `220 30% 95%` | `#EEF1F6` | Subtle blue-tinted button/chip fill |
| `--secondary-foreground` | `220 34% 34%` | `#394D74` | |
| `--muted` | `220 20% 96%` | `#F3F4F7` | Section/row backgrounds, hover |
| `--muted-foreground` | `220 20% 46%` | `#5E6D8D` | Helper text, labels, table headers |
| `--accent` | `355 62% 58%` | `#D6515D` | SPO Red proper — highlights, ghost hover |
| `--accent-foreground` | `0 0% 100%` | `#FFFFFF` | |
| `--destructive` | `355 62% 58%` | `#D6515D` | Delete, error |
| `--destructive-foreground` | `0 0% 100%` | `#FFFFFF` | |
| `--border` / `--input` | `220 20% 88%` | `#DADEE7` | All borders, input outlines |
| `--ring` | `220 34% 34%` | `#394D74` | **Focus ring — blue, not red** |
| `--primary-strong` | `348 85% 49%` | `#E7133D` | **Red as *text* on a light ground** — see §9 |

Note there are two reds on purpose: `--primary` (`#F04769`, brighter, for CTAs) and
`--accent`/`--destructive` (`#D6515D`, the literal brand red). Do not collapse them.

`--primary-strong` is a third, darker red that exists purely for contrast: `--primary` is
too light to carry its own 14px label at WCAG AA. Fills, borders and hover states use
`--primary`; red *text* and red icons on a light ground use `--primary-strong`. §9 has the
measurements.

### 2.3 Semantic tokens — dark mode

Applied via `.dark` class on `<html>`. Slate-navy, not neutral gray.

| Token | HSL | Hex |
|---|---|---|
| `--background` | `222 47% 11%` | `#0F1729` |
| `--foreground` | `210 40% 98%` | `#F8FAFC` |
| `--card` / `--popover` | `222 47% 14%` | `#131D34` |
| `--primary` | `348 85% 61%` | `#F04769` (unchanged — brand anchor) |
| `--secondary` | `217 33% 20%` | `#222F44` |
| `--muted` | `217 33% 18%` | `#1F2A3D` |
| `--muted-foreground` | `215 20% 65%` | `#94A3B8` |
| `--accent` | `355 62% 58%` | `#D6515D` (unchanged) |
| `--destructive` | `0 63% 55%` | `#D54444` |
| `--border` / `--input` | `217 33% 25%` | `#2B3B55` |
| `--ring` | `210 40% 70%` | `#94B2D1` |
| `--primary-strong` | `348 85% 61%` | `#F04769` (same as `--primary` — already 4.64:1 on `--card`) |

**Rule:** `--primary` and `--accent` never change between themes. Everything else inverts.
Cards in dark mode are *lighter* than the page (`#131D34` on `#0F1729`) — layering is by
lightness, not by shadow.

### 2.4 Chart palette

Six ordered series tokens, theme-aware. Import from a shared module, never hardcode:

```ts
// lib/chart-palette.ts
export const CHART_COLORS = [
  "hsl(var(--chart-1))", // SPO Blue (light) / near-white (dark) — primary series
  "hsl(var(--chart-2))", // SPO Red — comparison series
  "hsl(var(--chart-3))", // Green — positive / on-pace
  "hsl(var(--chart-4))", // Amber — warning / behind
  "hsl(var(--chart-5))", // Purple
  "hsl(var(--chart-6))", // Cyan
] as const
```

| Token | Light | Dark | Semantic meaning |
|---|---|---|---|
| `--chart-1` | `#394D74` | `#F8FAFC` | Primary / "you" |
| `--chart-2` | `#F04769` | `#F25A78` | Comparison / target |
| `--chart-3` | `#1CA64F` | `#42D778` | **Positive, on-pace, healthy** |
| `--chart-4` | `#F59F0A` | `#F7B645` | **Warning, behind pace** |
| `--chart-5` | `#855CCC` | `#A683E2` | Categorical |
| `--chart-6` | `#0DA2E7` | `#48BEF4` | Categorical |

Chart-3 and chart-4 carry meaning. Do not use them as arbitrary categorical fills.

### 2.5 Status colors

Semantic status uses Tailwind's palette with explicit dark variants, exposed through
`Badge` variants — do not invent new status colors per app:

| Status | Light | Dark |
|---|---|---|
| success | `bg-green-100 text-green-800` | `bg-green-900/50 text-green-200` |
| warning | `bg-amber-100 text-amber-800` | `bg-amber-900/50 text-amber-200` |
| info | `bg-blue-100 text-blue-800` | `bg-blue-900/50 text-blue-200` |
| orange | `bg-orange-100 text-orange-800` | `bg-orange-900/50 text-orange-200` |

Numeric trend deltas: `text-green-600 dark:text-green-400` up / `text-red-600
dark:text-red-400` down.

---

## 3. Typography

Single family, weight and size do the work. No display/body font pairing.

```js
fontFamily: { sans: ["Inter", "system-ui", "sans-serif"] }
```

> ⚠️ In DonorCRM, Inter is declared but **never actually loaded** — the app renders in
> `system-ui`. For new apps, decide deliberately: either self-host/preload Inter, or drop
> it from the stack and let `system-ui` be the real answer. Do not copy the current
> half-state. See §11.

### Scale

| Role | Classes |
|---|---|
| Marketing H1 | `text-4xl md:text-5xl font-semibold tracking-tight` |
| Marketing H2 | `text-3xl md:text-4xl font-semibold tracking-tight` |
| **App page title** | `text-3xl font-semibold tracking-tight` |
| Section heading | `text-2xl font-semibold mb-6 pb-2 border-b border-border` |
| Card title | `text-2xl font-semibold leading-none tracking-tight` |
| Sub-heading | `text-lg font-medium` |
| Body | `text-base leading-7` (cap at `max-w-prose`) |
| Large body | `text-lg leading-8` (marketing only) |
| UI default | `text-sm` |
| Helper / meta | `text-sm text-muted-foreground` |
| Micro label | `text-xs text-muted-foreground` |
| Stat value | `text-2xl font-semibold` (use `tabular-nums` for aligned figures) |

**Weights:** `font-medium` (500) for UI and nav, `font-semibold` (600) for headings and
stat values. `font-bold` is not part of the system — if you find it, it's drift.

**Tracking:** `tracking-tight` on headings ≥ `text-2xl`. `tracking-wide` on outlined
button labels only.

---

## 4. Shape, spacing, elevation

```css
--radius: 0.75rem;  /* 12px */
```

| Element | Radius |
|---|---|
| Cards, buttons, inputs, nav items | `rounded-lg` (12px) |
| Badges, small chips, icon hit-areas | `rounded-md` (10px) |
| Avatars, status dots | `rounded-full` |
| **Buttons** | **never `rounded-full`** |

**Spacing rhythm** — the system is 4px-based, but only these steps are in regular use:

| Context | Value |
|---|---|
| Vertical stack inside a page | `space-y-6` |
| Vertical stack inside a card | `space-y-2` / `space-y-4` |
| Card padding | `p-6` (compact stat tiles: `p-4`) |
| Grid gutters | `gap-6` content · `gap-3` dense dashboard tiles |
| Section padding | `py-12 md:py-16` · large `py-16 md:py-20` |
| Container padding | `px-4 sm:px-6 lg:px-8` |
| Header / sidebar-logo height | `h-16` |
| Sidebar width | `w-64` |

**Elevation** — the system is nearly flat:

| Layer | Treatment |
|---|---|
| Page, cards, tables | `border border-border`, no shadow |
| Dropdown, popover, sheet, toast | `shadow-lg` |
| Modal overlay | `bg-black/80` |

Never add `shadow-md` to a card to "make it pop". Use `bg-muted` or a border instead.

**Motion** — restrained. `transition-colors` on every interactive element; 200ms
transforms for chevrons/accordions. No entrance animations on data, no parallax.

---

## 5. Components

Only the SPO-specific deltas from stock shadcn are listed. Everything unlisted is stock.

### 5.1 Button — the signature component

```tsx
// Default variant: OUTLINE-FIRST
// Border stays --primary; the LABEL uses --primary-strong so it clears AA (§9).
"border-2 border-primary bg-background text-primary-strong hover:bg-primary hover:text-white tracking-wide"
```

> The shipped DonorCRM variant uses `text-primary` here, which measures 3.61:1 and fails
> AA for its own 14px label. New apps should use `text-primary-strong` as written above.

| Variant | Appearance | When |
|---|---|---|
| `default` | 2px red border, white bg, red text → solid red on hover | **Every primary CTA** |
| `outline` | identical to `default` | Compatibility alias |
| `secondary` | `bg-secondary` + border, subtle | Secondary action beside a CTA |
| `ghost` | no border, `hover:bg-accent` | Icon buttons, toolbars, nav |
| `link` | `text-primary-strong`, underline on hover | Inline text actions |
| `destructive` | **solid** red fill | Delete/irreversible only — sparingly |
| `spoOutline` | transparent bg, 100ms linear transition | Exact spo.org donate-page match |

| Size | Height |
|---|---|
| `sm` | `h-9 px-3 text-sm` |
| `default` | `h-10 px-4 text-sm` |
| `lg` | `h-12 px-6 text-base` |
| `icon` | `h-10 w-10` |

Icons: `[&_svg]:size-4 [&_svg]:shrink-0`, `gap-2` from the label.
Focus: `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` (blue ring).

> ⚠️ The 2px `border-primary` is fine at 3:1 (UI components), but `--primary` as a *label*
> measures only 3.61:1 — hence `text-primary-strong` above. Measurements in §9.

### 5.2 Card

```tsx
<Card>                            // rounded-lg border border-border bg-card, NO shadow
  <CardHeader>                    // flex flex-col space-y-1.5 p-6
    <CardTitle />                 // text-2xl font-semibold leading-none tracking-tight
    <CardDescription />           // text-sm text-muted-foreground
  </CardHeader>
  <CardContent />                 // p-6 pt-0
  <CardFooter />                  // flex items-center p-6 pt-0
</Card>
```

Cards are the default container for every discrete unit of content. A page is usually a
stack of cards, not a stack of bare sections.

### 5.3 Stat tile

Compact card, label above value. Note the tighter padding than a normal card.

```tsx
<Card>
  <CardHeader className="p-4 pl-7 pb-2">
    <div className="flex items-center justify-between">
      <CardDescription>{title}</CardDescription>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
    <CardTitle className="text-2xl">{isLoading ? <span className="text-muted-foreground">--</span> : value}</CardTitle>
    <div className="flex items-center gap-2 text-sm">
      <span className="font-medium text-green-600 dark:text-green-400">+12%</span>
      <span className="text-muted-foreground">{description}</span>
    </div>
  </CardHeader>
</Card>
```

Loading state is `--`, never a spinner, never `0`.

### 5.4 Badge

`rounded-md border px-2.5 py-0.5 text-xs font-semibold`. Variants: `default` (solid
primary), `secondary`, `destructive`, `outline`, plus the four status variants in §2.5.
Badges carry status; they are not decorative.

### 5.5 Input & form fields

`h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm`, blue focus ring.

Field group pattern:
```tsx
<div className="space-y-2">
  <Label htmlFor="x">Label</Label>
  <Input id="x" />
  <p className="text-sm text-muted-foreground">Helper text</p>
</div>
```

Error state — three coordinated changes:
```tsx
<Label className="text-destructive">Email</Label>
<Input className="border-destructive focus-visible:ring-destructive" />
<p className="text-sm text-destructive">Please enter a valid email address.</p>
```

Number inputs: spinner arrows are globally suppressed (see `globals.css` in §10). Poor UX
for currency and counts.

### 5.6 Table

`w-full caption-bottom text-sm` inside `<div className="relative w-full overflow-auto">`.

| Part | Treatment |
|---|---|
| `TableHead` | `h-12 px-4 text-left font-medium text-muted-foreground` |
| `TableCell` | `p-4 align-middle` |
| `TableRow` | `border-b hover:bg-muted/50` |
| `TableFooter` | `border-t bg-muted/50 font-medium` |

Conventions: right-align numeric columns (`text-right`); link the identity column with
`className="font-medium hover:underline text-primary-strong"`; use `<Badge>` for enum columns;
always set `aria-label` on the `<Table>`.

---

## 6. Layout & navigation

### App shell

```tsx
<div className="flex h-screen overflow-hidden bg-background">
  <div className="hidden lg:flex lg:w-64 lg:flex-col"><Sidebar /></div>
  <div className="flex flex-1 flex-col overflow-hidden">
    <Header />                                    {/* h-16 border-b */}
    <main className="flex-1 overflow-y-auto">{children}</main>
  </div>
</div>
```

Sidebar collapses below `lg`; on mobile the same `<Sidebar>` renders inside a left `Sheet`
opened from a hamburger in the header. One nav component, two presentations — never
maintain a separate mobile nav.

### Sidebar

- `bg-background border-r border-border`, logo block `h-16 border-b`.
- Nav item: `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors`
- Active: `bg-primary/10 text-primary-strong` — **tinted, never solid.**
- Idle: `text-muted-foreground hover:bg-muted hover:text-foreground`
- Icons `h-5 w-5` top-level, `h-4 w-4` nested.
- Grouped sections use Radix `Collapsible` with a rotating `ChevronDown`, open state
  persisted in `localStorage`, auto-expanding when a child route is active.
- Bottom-pinned utility group (`Settings`, admin) separated by `border-t`.

### Header

`h-16 border-b border-border bg-background flex items-center justify-between px-4 lg:px-6`.
Left: mobile menu trigger. Right: theme toggle (ghost icon button, Sun/Moon) + user
dropdown (`h-8 w-8 rounded-full bg-primary/10` avatar circle with `text-primary-strong` icon).

### Page composition

```tsx
<Section>                                    {/* py-12 md:py-16 */}
  <Container>                                {/* mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 */}
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Page Title</h1>
        <p className="text-muted-foreground mt-1">One-line description of what's here.</p>
      </div>
      {/* cards, tables, filters */}
    </div>
  </Container>
</Section>
```

Every page opens with the same title + muted subtitle block. Grids:
`grid gap-6 md:grid-cols-2 lg:grid-cols-3` content · `grid gap-3 sm:grid-cols-2
md:grid-cols-4` stat rows.

---

## 7. States

Consistency here matters more than cleverness — these are the moments users see most.

| State | Pattern |
|---|---|
| Loading (page) | `<div className="flex items-center justify-center h-64 text-muted-foreground">Loading...</div>` |
| Loading (stat) | `--` in `text-muted-foreground` |
| Empty | `<div className="text-center py-8 text-muted-foreground">No late donations! All pledges are on track.</div>` |
| Error (inline) | `<div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive">Failed to load data. Please try again.</div>` |
| Success/failure of an action | `sonner` toast |

Empty-state copy is **positive and specific**, not "No data". Say what it means:
"No late donations! All pledges are on track."

Toasts: `toast.success` / `.error` / `.info` / `.warning`. Short, sentence case, no
trailing period for fragments.

---

## 8. Data conventions

These are product rules that keep the suite behaving identically, not just looking alike.

- **Money is integer cents end-to-end.** Format only at the render boundary. Never render
  raw cents, never use floats for money.
  ```ts
  formatCents(1245000)               // "$12,450.00"
  formatCents(1245000, {whole: true})// "$12,450"
  formatCents(null)                  // "—"
  ```
- **Nullish values render as an em-dash `—`,** never blank, `null`, or `N/A`.
- **Date-only strings must not go through `new Date()`** — `"2026-02-01"` parses as UTC
  midnight and displays as Jan 31 in US timezones. Use a `formatLocalDate()` helper.
- **Percentages** clamp for display (DonorCRM caps at 150%) so progress bars stay
  meaningful without hiding overruns.
- **Filter state lives in the URL** (`nuqs`), so views are shareable. Pass a clean
  `Record<string, string>` as query keys — `undefined` values collide under JSON
  serialization.
- **Server state is React Query**, `staleTime: 5min`. No Redux/Zustand.

---

## 9. Accessibility

Measured against the tokens in §2 — these are computed WCAG ratios, not estimates.

| Pair | Ratio | Verdict |
|---|---|---|
| Body `#394D74` on white | 8.44:1 | AAA |
| Muted `#5E6D8D` on white | 5.19:1 | AA |
| Muted `#5E6D8D` on `--muted` | 4.72:1 | AA |
| Dark body `#F8FAFC` on `#0F1729` | 17.08:1 | AAA |
| Dark muted `#94A3B8` on `#0F1729` | 6.97:1 | AA |
| **Primary `#F04769` text on white** | **3.61:1** | **Fails AA for 14px text** |

**This is why `--primary-strong` exists.** In shipped DonorCRM the default button and every
`text-primary` link sit at 3.61:1 — fine for a 2px border or a fill (3:1 for UI components),
short of the 4.5:1 their own 14px labels need. The specs in §2 and §5 above are already
written against the fix; this is the token that backs them:

```css
:root {
  --primary: 348 85% 61%;          /* #F04769 — fills, borders, hover backgrounds */
  --primary-strong: 348 85% 49%;   /* #E7133D — 4.60:1 on white; red TEXT and icons */
}
.dark {
  --primary: 348 85% 61%;
  --primary-strong: 348 85% 61%;   /* #F04769 is 4.64:1 on --card; no change needed */
}
```

Expose it in `tailwind.config.js` as `primary.strong` (see §10) so it is reachable as
`text-primary-strong`. Applies to: the default/outline button label, `link` buttons, table
identity links, active sidebar labels, and any red icon on a light ground. The border, the
hover fill, and `bg-primary/10` tints all stay on `--primary`.

**Porting to DonorCRM itself** is a four-line change — add the two token declarations, add
the Tailwind color entry, then swap `text-primary` → `text-primary-strong` in
`button.tsx`, `Sidebar.tsx`, and the table link class. Nothing else in the palette moves.

Non-negotiables:
- Every interactive element keeps `focus-visible:ring-2 ring-ring ring-offset-2`. Never
  `outline-none` without a replacement.
- Icon-only buttons carry `aria-label` **and** an `<span className="sr-only">`.
- Tables get `aria-label`; `<th>` keeps `scope="col"`.
- Modals/sheets always have a `SheetTitle`/`DialogTitle`, `sr-only` if visually absent.
- Status is never communicated by color alone — badges carry text.
- Respect `prefers-reduced-motion` for anything beyond `transition-colors`.

---

## 10. Starter files

### `src/styles/globals.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --spo-blue: 220 34% 34%;
    --spo-red: 355 62% 58%;
    --spo-white: 0 0% 100%;

    --background: 0 0% 100%;
    --foreground: 220 34% 34%;
    --card: 0 0% 100%;
    --card-foreground: 220 34% 34%;
    --popover: 0 0% 100%;
    --popover-foreground: 220 34% 34%;

    --primary: 348 85% 61%;
    --primary-foreground: 0 0% 100%;
    --primary-strong: 348 85% 49%;   /* accessible red for TEXT on light — see §9 */

    --secondary: 220 30% 95%;
    --secondary-foreground: 220 34% 34%;
    --muted: 220 20% 96%;
    --muted-foreground: 220 20% 46%;
    --accent: 355 62% 58%;
    --accent-foreground: 0 0% 100%;
    --destructive: 355 62% 58%;
    --destructive-foreground: 0 0% 100%;

    --border: 220 20% 88%;
    --input: 220 20% 88%;
    --ring: 220 34% 34%;
    --radius: 0.75rem;

    --chart-1: 220 34% 34%;
    --chart-2: 348 85% 61%;
    --chart-3: 142 71% 38%;
    --chart-4: 38 92% 50%;
    --chart-5: 262 52% 58%;
    --chart-6: 199 89% 48%;
  }

  .dark {
    --background: 222 47% 11%;
    --foreground: 210 40% 98%;
    --card: 222 47% 14%;
    --card-foreground: 210 40% 98%;
    --popover: 222 47% 14%;
    --popover-foreground: 210 40% 98%;

    --primary: 348 85% 61%;
    --primary-foreground: 0 0% 100%;
    --primary-strong: 348 85% 61%;

    --secondary: 217 33% 20%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217 33% 18%;
    --muted-foreground: 215 20% 65%;
    --accent: 355 62% 58%;
    --accent-foreground: 0 0% 100%;
    --destructive: 0 63% 55%;
    --destructive-foreground: 0 0% 100%;

    --border: 217 33% 25%;
    --input: 217 33% 25%;
    --ring: 210 40% 70%;

    --chart-1: 210 40% 98%;
    --chart-2: 348 85% 65%;
    --chart-3: 142 65% 55%;
    --chart-4: 38 92% 62%;
    --chart-5: 262 62% 70%;
    --chart-6: 199 89% 62%;
  }

  * { @apply border-border; }

  body {
    @apply bg-background text-foreground;
    font-feature-settings: "rlig" 1, "calt" 1;
  }

  /* Spinner arrows are poor UX for currency/count fields and inconsistent across browsers. */
  input[type="number"]::-webkit-outer-spin-button,
  input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  input[type="number"] { -moz-appearance: textfield; appearance: textfield; }
}

@layer utilities {
  .text-balance { text-wrap: balance; }
  .container-custom { @apply mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8; }
  .section-padding { @apply py-12 md:py-16; }
  .section-padding-lg { @apply py-16 md:py-20; }
}
```

### `tailwind.config.js`

```js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: { DEFAULT: "1rem", sm: "1.5rem", lg: "2rem" },
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        spo: { blue: "#3A4D75", red: "#D74F59", white: "#FFFFFF" },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          strong: "hsl(var(--primary-strong))",
        },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: { sans: ["Inter", "system-ui", "sans-serif"] },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
```

### `index.html` — flash-free theme bootstrap

Runs before React so the correct theme paints on first frame. Swap the storage key per app.

```html
<script>
  (function(){
    var t = localStorage.getItem("<app>-theme");
    if (t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
      document.documentElement.classList.add("dark");
    }
  })();
</script>
```

Pair it with a `ThemeProvider` exposing `theme: "light" | "dark" | "system"`,
`resolvedTheme`, and a `setTheme` that writes the same key and listens for
`prefers-color-scheme` changes while in `system`.

### `src/lib/utils.ts`

```ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

---

## 11. Known gaps — fix these in new apps, don't copy them

Found while extracting this spec from DonorCRM. Each is a real drift between the
documented system and the shipped code.

| # | Issue | Action for a new app |
|---|---|---|
| 1 | **Inter is configured but never loaded.** `tailwind.config.js` declares it; no `@font-face`, no stylesheet link. The app actually renders in `system-ui`. | Either self-host + preload Inter, or drop it from the font stack. Pick one. |
| 2 | **Karla is loaded from Google Fonts** but used by exactly one button variant (`spoDonate`). A blocking third-party request for a marketing edge case. | Drop it unless the app has an spo.org-matching donate CTA; then self-host and subset. |
| 3 | **`Toaster` hardcodes `theme="light"`** (`components/ui/sonner.tsx`), so toasts stay light in dark mode. | Wire it to `resolvedTheme` from `ThemeProvider`. |
| 4 | **Primary red fails AA as text** (3.61:1). | Adopt `--primary-strong` per §9. |
| 5 | **`Styleguide.tsx` color values are stale** — it labels primary as `#D11F3A` and foreground as "Near-black"; both are wrong against current tokens. | Generate swatches from the CSS variables instead of hardcoding hex captions. |
| 6 | **`font-bold` and ad-hoc `text-2xl font-bold` stat values** appear alongside the documented `font-semibold`. | Standardize on `font-semibold`; lint for `font-bold`. |
| 7 | **Currency formatting is duplicated** — a shared `formatCents` exists, yet several pages define a local `formatCurrency`. | One formatting module, imported everywhere. |

---

## 12. Do / Don't

**Do**
- Reach for a semantic token (`bg-muted`, `text-muted-foreground`) before a literal color.
- Start every page with `Section > Container > space-y-6` + title/subtitle block.
- Keep the outline-first CTA — it is the most recognizable SPO element.
- Give every state (loading, empty, error) the documented treatment.
- Test both themes before calling anything done.

**Don't**
- Add shadows to cards, or pill-shaped buttons.
- Use solid red as a resting state for anything but destructive actions.
- Hardcode `#3A4D75` / `#D74F59` in component styles — dark mode will break.
- Use `text-black`, `bg-white`, or `bg-gray-*` — use `foreground`/`background`/`muted`.
- Ship "No data" as empty-state copy.
- Introduce a second font family, a new radius, or a new status color per app.
```
