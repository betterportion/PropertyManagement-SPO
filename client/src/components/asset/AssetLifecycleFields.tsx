import { useQuery } from "@tanstack/react-query";
import { type UseFormReturn } from "react-hook-form";

import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_LIFESPAN_YEARS } from "@shared/assetLifecycle";
import type { MaintenanceContact, Resident, User } from "@shared/schema";

/**
 * The lifecycle, value, assignment and provenance fields, shared by the add
 * and edit asset dialogs.
 *
 * Extracted for the same reason `PropertyLeaseFields` was: two copies of a
 * form field is two places for a label, a limit or a test id to drift. The
 * assignment block only appears for a movable asset, because a roof is not
 * lent to anybody.
 */

/** The "nobody" option. A Select cannot carry an empty string as a value. */
const NOBODY = "__none__";

/** Whatever shape the dialog's form actually is; only these names are touched. */
type AnyAssetForm = UseFormReturn<any>;

export default function AssetLifecycleFields({
  form,
  isMovable,
}: {
  form: AnyAssetForm;
  isMovable: boolean;
}) {
  const category = form.watch("category") as string | undefined;
  const categoryDefault = category ? DEFAULT_LIFESPAN_YEARS[category] : undefined;

  const { data: contacts = [] } = useQuery<MaintenanceContact[]>({ queryKey: ["/api/contacts"] });
  const { data: residents = [] } = useQuery<Resident[]>({ queryKey: ["/api/residents"] });
  // Only an account holding canManageUsers can read this; everyone else gets
  // an empty staff picker and the free-text fallback rather than a broken form.
  const { data: staff = [] } = useQuery<User[]>({ queryKey: ["/api/users"], retry: false });

  const dateField = (name: string, label: string, hint?: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="date"
              {...field}
              value={field.value ?? ""}
              data-testid={`input-asset-${name}`}
            />
          </FormControl>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        {dateField(
          "acquisitionDate",
          "Acquired on",
          "Without this the asset stays unrated — never guessed at.",
        )}

        <FormField
          control={form.control}
          name="expectedLifespanYears"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Expected life (years)</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={0}
                  {...field}
                  value={field.value ?? ""}
                  onChange={(event) =>
                    field.onChange(event.target.value ? Number(event.target.value) : null)
                  }
                  placeholder={categoryDefault ? String(categoryDefault) : "No default"}
                  data-testid="input-asset-lifespan"
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                {categoryDefault
                  ? `Leave blank to use the ${categoryDefault}-year default for ${category}.`
                  : "This category has no default, so an asset without a figure here stays unrated."}
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {dateField(
        "replacementDueDate",
        "Replacement due (overrides the above)",
        "Set this when you know better than the calculation. This is the permanent correction — to park a warning temporarily, use Snooze instead.",
      )}

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="currentValue"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Current value</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  {...field}
                  value={field.value ?? ""}
                  onChange={(event) =>
                    field.onChange(event.target.value ? Number(event.target.value) : null)
                  }
                  data-testid="input-asset-current-value"
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                Kept alongside the purchase price, never instead of it — insurance cares about
                what a thing is worth now.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        {dateField("valuedOn", "Valued on")}
      </div>

      {isMovable && (
        <>
          <FormField
            control={form.control}
            name="assignedResidentId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Assigned to a resident</FormLabel>
                <Select
                  onValueChange={(value) => field.onChange(value === NOBODY ? null : value)}
                  value={field.value ?? NOBODY}
                >
                  <FormControl>
                    <SelectTrigger data-testid="select-asset-assigned-resident">
                      <SelectValue placeholder="Nobody" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NOBODY}>Nobody</SelectItem>
                    {residents.map((resident) => (
                      <SelectItem key={resident.id} value={resident.id}>
                        {resident.firstName} {resident.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="assignedUserId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Or to a staff account</FormLabel>
                <Select
                  onValueChange={(value) => field.onChange(value === NOBODY ? null : value)}
                  value={field.value ?? NOBODY}
                >
                  <FormControl>
                    <SelectTrigger data-testid="select-asset-assigned-user">
                      <SelectValue placeholder="Nobody" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NOBODY}>Nobody</SelectItem>
                    {staff.map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {[person.firstName, person.lastName].filter(Boolean).join(" ") || person.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="assignedToName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Or just a name</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ""} data-testid="input-asset-assigned-name" />
                </FormControl>
                <p className="text-xs text-muted-foreground">
                  Only for somebody who is neither a resident nor an account. A real link is what
                  lets "collect everything before he leaves" work.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          {dateField("expectedReturnDate", "Expected back")}
        </>
      )}

      <FormField
        control={form.control}
        name="supplierContactId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Supplier</FormLabel>
            <Select
              onValueChange={(value) => field.onChange(value === NOBODY ? null : value)}
              value={field.value ?? NOBODY}
            >
              <FormControl>
                <SelectTrigger data-testid="select-asset-supplier">
                  <SelectValue placeholder="Not recorded" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value={NOBODY}>Not recorded</SelectItem>
                {contacts.map((contact) => (
                  <SelectItem key={contact.id} value={contact.id}>
                    {contact.company} — {contact.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="acquisitionNotes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>How it was bought, and how that went</FormLabel>
            <FormControl>
              <Textarea
                rows={3}
                placeholder="Where it came from, which supplier, whether you would use them again."
                {...field}
                value={field.value ?? ""}
                data-testid="textarea-asset-acquisition-notes"
              />
            </FormControl>
            <p className="text-xs text-muted-foreground">
              Institutional memory that otherwise dies at handover.
            </p>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}
