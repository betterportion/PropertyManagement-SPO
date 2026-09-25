import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useRoomSuggestions } from "@/hooks/useRoomSuggestions";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Resident } from "@shared/schema";

/**
 * Correcting a resident's basics after they were added.
 *
 * The first client caller of `PATCH /api/residents/:id`. The house is not
 * here on purpose: the server refuses to move a resident between houses, and
 * a person in the wrong house is a delete and a re-add. Move-out has its own
 * action because it also deactivates the login.
 */

const schema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  email: z.string().trim().email("Enter a valid email address"),
  phone: z.string().optional(),
  roomName: z.string().optional(),
  moveInDate: z.string().optional(),
  notes: z.string().optional(),
});
type Values = z.infer<typeof schema>;

function toDateInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export default function ResidentEditDialog({
  resident,
  open,
  onOpenChange,
}: {
  resident: Resident;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const roomSuggestions = useRoomSuggestions(resident.propertyId);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      firstName: resident.firstName,
      lastName: resident.lastName,
      email: resident.email,
      phone: resident.phone ?? "",
      roomName: resident.roomName ?? "",
      moveInDate: toDateInput(resident.moveInDate),
      notes: resident.notes ?? "",
    },
  });

  // Reopening after a save shows the saved values, not the ones typed last time.
  useEffect(() => {
    if (open) {
      form.reset({
        firstName: resident.firstName,
        lastName: resident.lastName,
        email: resident.email,
        phone: resident.phone ?? "",
        roomName: resident.roomName ?? "",
        moveInDate: toDateInput(resident.moveInDate),
        notes: resident.notes ?? "",
      });
    }
  }, [open, resident, form]);

  const save = useMutation({
    mutationFn: async (values: Values) =>
      await apiRequest("PATCH", `/api/residents/${resident.id}`, {
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email,
        phone: values.phone?.trim() || null,
        roomName: values.roomName?.trim() || null,
        moveInDate: values.moveInDate || null,
        notes: values.notes?.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/residents"] });
      onOpenChange(false);
      toast({ title: "Saved" });
    },
    onError: () => {
      toast({ title: "That did not save", description: "Check the email address and try again.", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit resident</DialogTitle>
          <DialogDescription>
            Their house cannot be changed here; a person in the wrong house is removed and added again.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((values) => save.mutate(values))} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField control={form.control} name="firstName" render={({ field }) => (
                <FormItem>
                  <FormLabel>First name</FormLabel>
                  <FormControl><Input {...field} data-testid="input-edit-resident-first" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="lastName" render={({ field }) => (
                <FormItem>
                  <FormLabel>Last name</FormLabel>
                  <FormControl><Input {...field} data-testid="input-edit-resident-last" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl><Input type="email" {...field} data-testid="input-edit-resident-email" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField control={form.control} name="phone" render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                  <FormControl><Input type="tel" {...field} data-testid="input-edit-resident-phone" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="roomName" render={({ field }) => (
                <FormItem>
                  <FormLabel>Room <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                  <FormControl>
                    <Input {...field} list="edit-resident-room-suggestions" placeholder="e.g., Bedroom 2" data-testid="input-edit-resident-room" />
                  </FormControl>
                  <datalist id="edit-resident-room-suggestions">
                    {roomSuggestions.map((name) => <option key={name} value={name} />)}
                  </datalist>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="moveInDate" render={({ field }) => (
              <FormItem>
                <FormLabel>Move-in date <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                <FormControl><Input type="date" {...field} data-testid="input-edit-resident-movein" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem>
                <FormLabel>Notes <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                <FormControl><Textarea rows={3} {...field} data-testid="input-edit-resident-notes" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={save.isPending} data-testid="button-save-resident">
                {save.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
