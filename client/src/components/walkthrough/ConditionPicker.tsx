import { WALKTHROUGH_CONDITIONS, type WalkthroughCondition } from "@shared/schema";
import { CONDITION_HINT, CONDITION_LABEL, conditionTone, type ConditionTone } from "@/lib/walkthrough";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Undo2 } from "lucide-react";

/**
 * The one-tap condition entry for a single checklist item.
 *
 * Every chip carries its word — "Good", "Damaged", "Not here". Colour is a
 * second signal and never the only one, because an RA reading this in a dim
 * basement, or one who cannot separate the hues, still has to be able to see
 * what they recorded.
 *
 * `not_recorded` is not a chip. It is the state an item starts in, and the
 * "Not checked yet" button puts an item back into it after a mis-tap.
 */

/** The five real answers, in the order they are tapped most. */
const CHOICES = WALKTHROUGH_CONDITIONS.filter((c) => c !== "not_recorded");

const TONE_SELECTED: Record<ConditionTone, string> = {
  good: "border-emerald-600 bg-emerald-100 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950 dark:text-emerald-100",
  neutral: "border-primary bg-primary/15 text-primary-strong dark:text-foreground",
  warn: "border-amber-600 bg-amber-100 text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100",
  bad: "border-red-600 bg-red-100 text-red-900 dark:border-red-500 dark:bg-red-950 dark:text-red-100",
  muted: "border-foreground/40 bg-muted text-foreground",
};

interface ConditionPickerProps {
  value: WalkthroughCondition;
  onChange: (condition: WalkthroughCondition) => void;
  disabled?: boolean;
  /** Suffix for the data-testid of each chip, normally the item id. */
  testId: string;
}

export default function ConditionPicker({ value, onChange, disabled, testId }: ConditionPickerProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Condition">
        {CHOICES.map((choice) => {
          const selected = value === choice;
          return (
            <button
              key={choice}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              title={CONDITION_HINT[choice]}
              onClick={() => onChange(choice)}
              className={cn(
                "min-h-11 rounded-md border-2 px-3 text-sm font-medium transition-colors",
                "disabled:pointer-events-none disabled:opacity-50",
                selected
                  ? TONE_SELECTED[conditionTone(choice)]
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
              data-testid={`button-condition-${choice}-${testId}`}
            >
              {CONDITION_LABEL[choice]}
            </button>
          );
        })}
      </div>
      {value !== "not_recorded" && !disabled && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange("not_recorded")}
          data-testid={`button-condition-clear-${testId}`}
        >
          <Undo2 className="h-3.5 w-3.5" />
          Not checked yet
        </Button>
      )}
    </div>
  );
}
