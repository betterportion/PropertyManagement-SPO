import { type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { insertPropertySchema } from "@shared/schema";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * The Properties form schema. The base `insertPropertySchema` types the lease
 * dates as `Date` (drizzle-zod coerces them), but a `<input type="date">` deals
 * in "YYYY-MM-DD" strings — so the form carries them as optional strings and the
 * server coerces on submit. Everything else is inherited unchanged.
 */
export const propertyFormSchema = insertPropertySchema.extend({
  leaseStartDate: z.string().optional(),
  leaseEndDate: z.string().optional(),
  leaseRenewalDate: z.string().optional(),
});
export type PropertyForm = z.infer<typeof propertyFormSchema>;

/**
 * Ownership + lease fields shared by the add and edit property dialogs. The
 * lease dates and renewal decision only show once a property is marked rented —
 * SPO owns some houses and rents others, and only rented ones have a lease.
 */
export default function PropertyLeaseFields({ form }: { form: UseFormReturn<PropertyForm> }) {
  const isRented = form.watch("ownership") === "rented";

  return (
    <>
      <FormField
        control={form.control}
        name="ownership"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Ownership</FormLabel>
            <Select onValueChange={field.onChange} value={field.value || "owned"}>
              <FormControl>
                <SelectTrigger data-testid="select-property-ownership">
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="owned">Owned by SPO</SelectItem>
                <SelectItem value="rented">Rented (has a lease)</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {isRented && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="leaseStartDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Lease start</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} value={field.value ?? ""} data-testid="input-property-lease-start" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="leaseEndDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Lease end</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} value={field.value ?? ""} data-testid="input-property-lease-end" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="leaseRenewalDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Renewal decision due</FormLabel>
                <FormControl>
                  <Input type="date" {...field} value={field.value ?? ""} data-testid="input-property-lease-renewal" />
                </FormControl>
                <p className="text-xs text-muted-foreground">You'll be reminded on the dashboard 2 months before this date.</p>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="renewalDecision"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Renewal decision</FormLabel>
                <Select onValueChange={field.onChange} value={field.value || "undecided"}>
                  <FormControl>
                    <SelectTrigger data-testid="select-property-renewal-decision">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="undecided">Undecided</SelectItem>
                    <SelectItem value="renewing">Renewing</SelectItem>
                    <SelectItem value="not_renewing">Not renewing</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}
    </>
  );
}
