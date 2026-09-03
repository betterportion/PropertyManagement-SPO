import { useQuery } from "@tanstack/react-query";
import { type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { insertPropertySchema, type MaintenanceContact } from "@shared/schema";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PhotoUpload } from "@/components/PhotoUpload";
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
  // Links, not documents. Settled with SPO: no lease is uploaded into the
  // portal, and a rented house's maintenance portal is reached by URL with a
  // contact beside it -- never a stored login.
  leaseDocumentUrl: z.string().trim().url("Paste the full link, starting with https://").or(z.literal("")).nullish(),
  maintenancePortalUrl: z.string().trim().url("Paste the full link, starting with https://").or(z.literal("")).nullish(),
  // The numeric column round-trips as a string; a number input yields a
  // number. The server coerces on submit, as it does for every other amount.
  depositAmount: z.coerce.number().min(0, "Must be 0 or greater").nullable().optional(),
});
export type PropertyForm = z.infer<typeof propertyFormSchema>;

/** The "nobody" option. A Select cannot carry an empty string as a value. */
const NO_CONTACT = "__none__";

/**
 * Ownership, lease and who-to-call fields, shared by the add and edit property
 * dialogs.
 *
 * The two branches ask for different things because they mean different things:
 * a rented house has a rental company and a portal its repairs are filed in, an
 * owned one has whoever SPO has made responsible. The recurring complaint was
 * that rental company contact details are hard to find, which is what the
 * linked contact solves — a real reference to a `maintenance_contacts` row, not
 * a name retyped into a notes field.
 */
export default function PropertyLeaseFields({ form }: { form: UseFormReturn<PropertyForm> }) {
  const isRented = form.watch("ownership") === "rented";

  // Contacts are the vendor list the rest of the app already keeps. A staff
  // account that cannot read them simply gets an empty picker rather than a
  // broken form.
  const { data: contacts = [] } = useQuery<MaintenanceContact[]>({
    queryKey: ["/api/contacts"],
  });

  const contactField = (
    name: "rentalCompanyContactId" | "responsibleContactId",
    label: string,
    hint: string,
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            onValueChange={(value) => field.onChange(value === NO_CONTACT ? null : value)}
            value={field.value ?? NO_CONTACT}
          >
            <FormControl>
              <SelectTrigger data-testid={`select-property-${name}`}>
                <SelectValue placeholder="Nobody chosen yet" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value={NO_CONTACT}>Nobody chosen yet</SelectItem>
              {contacts.map((contact) => (
                <SelectItem key={contact.id} value={contact.id}>
                  {contact.company} — {contact.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{hint}</p>
          <FormMessage />
        </FormItem>
      )}
    />
  );

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
            name="leaseDocumentUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Link to the lease on Drive</FormLabel>
                <FormControl>
                  <Input
                    type="url"
                    placeholder="https://drive.google.com/..."
                    {...field}
                    value={field.value ?? ""}
                    data-testid="input-property-lease-document"
                  />
                </FormControl>
                <p className="text-xs text-muted-foreground">
                  The portal stores the link, never the document. Keep the lease on Drive.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="maintenancePortalUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Maintenance portal</FormLabel>
                <FormControl>
                  <Input
                    type="url"
                    placeholder="https://..."
                    {...field}
                    value={field.value ?? ""}
                    data-testid="input-property-maintenance-portal"
                  />
                </FormControl>
                <p className="text-xs text-muted-foreground">
                  Where this house's repairs get filed. Never save a login here.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          {contactField(
            "rentalCompanyContactId",
            "Rental company contact",
            "Who to call about this house. Add them under Contacts first if they are not listed.",
          )}

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

      {/* 6.3 — SPO's own reminder setting, per house. Deliberately NOT a
          state-to-deadline lookup: the states SPO operates in have materially
          different rules (Arizona counts business days, Florida and Kansas are
          two-stage), and a table here would bake legal advice into the repo
          and go stale silently. SPO's admin and finance teams are responsible
          for compliance; the portal reminds. */}
      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="depositAmount"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Deposit for this house ($)</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  {...field}
                  value={field.value ?? ""}
                  onChange={(event) => field.onChange(event.target.value ? Number(event.target.value) : null)}
                  data-testid="input-property-deposit-amount"
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                The usual figure. Any one resident can be given a different amount on their own record.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="depositReturnDays"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Days to return a deposit</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={0}
                  {...field}
                  value={field.value ?? ""}
                  onChange={(event) => field.onChange(event.target.value ? Number(event.target.value) : null)}
                  data-testid="input-property-deposit-return-days"
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                SPO's own reminder setting, counted from the resident's move-out date. It is not a
                legal determination — check the rule for this state and set it accordingly.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={form.control}
        name="depositNotes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>What that setting is based on (Optional)</FormLabel>
            <FormControl>
              <Input
                {...field}
                value={field.value ?? ""}
                placeholder="e.g. 21 days, per the state statute our counsel pointed us at"
                data-testid="input-property-deposit-notes"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {!isRented &&
        contactField(
          "responsibleContactId",
          "Responsible maintenance person",
          "The contact SPO calls first for this house. Institutional memory that otherwise dies at handover.",
        )}
    </>
  );
}

/**
 * The front-of-house photo and the free-text notes, shared by the add and edit
 * dialogs for the same reason the lease fields are: two copies of a form field
 * is two places for a label, a limit or a test id to drift.
 *
 * `onPhotoError` is passed in rather than raising a toast here, so the page
 * that owns the dialog owns its own error surface.
 */
export function PropertyPhotoAndNotes({
  form,
  onPhotoError,
}: {
  form: UseFormReturn<PropertyForm>;
  onPhotoError: (message: string) => void;
}) {
  return (
    <>
      <FormField
        control={form.control}
        name="photoUrl"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Front-of-house photo (Optional)</FormLabel>
            <FormControl>
              {/* One image, replaceable. Download access is authorized against
                  the property itself, so it follows the house's region rule. */}
              <PhotoUpload
                existingUrl={field.value ?? undefined}
                onUpload={(url) => field.onChange(url)}
                onRemove={() => field.onChange(null)}
                onError={onPhotoError}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="notes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Notes (Optional)</FormLabel>
            <FormControl>
              <Textarea
                rows={3}
                placeholder="Anything the next RA should know about this house."
                {...field}
                value={field.value ?? ""}
                data-testid="textarea-property-notes"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}
