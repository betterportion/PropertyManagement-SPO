import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * SPO button — the signature component.
 *
 * Which variant to use:
 *   default / outline  Outlined red. The standard call to action on any page.
 *                      White background, 2px red border, red label, solid red on hover.
 *   primary            Solid red at rest. Reserved for THE single most important
 *                      action on a page (e.g. "Submit request"). One per page, never two.
 *   secondary          Tinted blue-gray. A supporting action sitting beside a CTA.
 *   ghost              No border. Icon buttons, toolbars, table row actions.
 *   link               Inline text action inside a sentence.
 *   destructive        Solid red. Delete and other irreversible actions only.
 *
 * Never add `rounded-full` — buttons are 12px corners across the whole suite.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-2 border-primary bg-background text-primary-strong tracking-wide hover:bg-primary hover:text-primary-foreground hover:border-primary active:bg-primary/90",
        outline:
          // Compatibility alias for `default` — the outlined CTA.
          "border-2 border-primary bg-background text-primary-strong tracking-wide hover:bg-primary hover:text-primary-foreground hover:border-primary active:bg-primary/90",
        // The solid CTA. Its background is --primary-STRONG, not --primary:
        // white on --primary is 3.61:1, which fails WCAG AA's 4.5:1 for normal
        // text, and e2e/a11y.spec.ts enforces "no serious violations".
        // --primary-strong is the palette's own darker shade of the same hue
        // and gives 5.95:1, so this stays the brand colour and passes.
        primary:
          "border-2 border-primary-strong bg-primary-strong text-primary-foreground tracking-wide hover:bg-primary hover:border-primary active:bg-primary-strong",
        secondary:
          "border border-border bg-secondary text-secondary-foreground hover:bg-secondary/70 active:bg-secondary",
        // Transparent border so toggling a border on later doesn't shift layout.
        ghost:
          "border border-transparent text-foreground hover:bg-muted hover:text-foreground active:bg-muted",
        link:
          "border border-transparent text-primary-strong underline-offset-4 hover:underline",
        destructive:
          "border-2 border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:border-destructive/90 active:bg-destructive",
      },
      // Heights are "min" heights so a button with unusually long content grows
      // instead of clipping, while normal content sits at the documented height.
      size: {
        default: "min-h-10 px-4 py-2 text-sm",
        sm: "min-h-9 px-3 text-sm",
        lg: "min-h-12 px-6 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
