# Design Guidelines — SPO Property Management Portal

## Where the rules live

The portal follows the **SPO Design System**, the shared specification used across the
suite of SPO applications. That document is the authority for every value — colors,
type scale, spacing, radius, component behavior, states and data display:

**[`docs/spo-design-system.md`](docs/spo-design-system.md)**

This file only records the decisions specific to this portal. Where the two disagree,
the SPO Design System wins, except for the portal-specific choices listed below.

A live reference is built into the app at **`/styleguide`** (staff only). It reads its
colors from the running theme, so it can never drift from the code. Check a new screen
against that page before calling it done.

## The five rules that make it look like SPO

1. **Primary calls to action are outlined, not solid.** White background, 2px red border,
   red label. Solid red on hover.
2. **Body text is navy, not black.** Nothing in light mode is `#000`.
3. **Cards use borders, not shadows.** Shadows appear only on floating layers — dropdowns,
   popovers, sheets, toasts.
4. **12px corners everywhere, never pills.** No `rounded-full` on a button or an input;
   only avatars and status dots.
5. **Sections breathe.** `Section` → `Container` → `space-y-6`. Dense dashboards are the
   exception, not the default.

## Portal-specific decisions

- **One solid red action per page.** The SPO spec reserves solid red at rest for
  destructive actions. This portal also allows it for the single most important action on
  a page — use `<Button variant="primary">` for that, and never place two on one screen.
  Everything else uses the outlined default.
- **`outline` is an alias of `default`.** Both render the outlined red CTA. A neutral
  supporting action is `variant="secondary"`, not `outline`.
- **Toasts stay on the existing Radix toast** (`useToast` / `<Toaster />`), restyled to the
  spec. The suite's `sonner` is not used here.
- **Money stays as stored.** The database keeps decimal amounts; the spec's integer-cents
  rule is not adopted. Format at the render boundary with `formatCurrency()` from
  `client/src/lib/format.ts`.
- **URL filter state does not use `nuqs`.** This app routes with `wouter`, which `nuqs`
  does not support. Filter state is read and written through a small hook over the router.
- **Menus and lists highlight in neutral gray, not red.** The spec makes `--accent` the
  brand red. Applied literally, every dropdown, select option and command row would fill
  solid red on hover, and the label contrast fell short of the accessibility target. Those
  primitives use the muted surface with normal text instead. `--accent` keeps its spec
  value and is still available for brand highlights.
- **Theme choice** lives in `localStorage` under `spo-portal-theme` and supports light,
  dark and system. A bootstrap script in `client/index.html` applies it before the first
  paint; keep the storage key in that script in sync with `ThemeProvider`.

## Where the pieces are

| Piece | Location |
|---|---|
| Theme tokens (light + dark) | `client/src/index.css` |
| Tailwind mappings, brand colors, radius | `tailwind.config.ts` |
| Buttons, cards, badges, inputs, tables, toasts | `client/src/components/ui/` |
| Page layout primitives | `client/src/components/layout/page.tsx` |
| Loading / empty / error patterns | `client/src/components/states.tsx` |
| Money, date and percentage formatters | `client/src/lib/format.ts` |
| Chart series colors | `client/src/lib/chart-palette.ts` |
| Theme provider and toggle | `client/src/providers/ThemeProvider.tsx`, `client/src/components/ThemeToggle.tsx` |
| Live reference page | `client/src/pages/Styleguide.tsx` (`/styleguide`) |

## Signs a screen has drifted

- `font-bold` anywhere — the system stops at `font-semibold`
- `bg-white`, `bg-gray-*`, `text-black` instead of the semantic tokens
- A shadow on a card
- `rounded-full` on a button
- "No data" as empty-state copy — say what the emptiness means
- A hardcoded hex color instead of a token
- Red text using `text-primary`; red **text** and icons use `text-primary-strong`, which is
  the darker red that meets contrast requirements. Fills and borders use `primary`.
