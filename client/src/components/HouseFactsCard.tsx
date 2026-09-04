import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDate } from "@/lib/format";
import { ACCESS_CODE_MAX_LENGTH, type Property, type PropertyFacts } from "@shared/schema";
import { ACCESS_CODES, HOUSE_FACT_TEXT_FIELDS } from "@shared/houseFacts";

/**
 * The house facts (ADR-0002): what the household needs to know, written by
 * staff here and read by the household leader and steward on their resource
 * hub. Visibly its own card, and deliberately never merged with the staff
 * notes above it -- this block reaches the household, those notes never do,
 * and the person typing has to be able to tell which box they are in.
 *
 * The three codes show when each was last changed. That date is set by the
 * server when a code's value changes and only then; the form never sends one.
 */

const TEXT_MAX = 4000;

const formSchema = z.object({
  doorCode: z.string().trim().max(ACCESS_CODE_MAX_LENGTH, "A code, not a paragraph"),
  gateCode: z.string().trim().max(ACCESS_CODE_MAX_LENGTH, "A code, not a paragraph"),
  alarmCode: z.string().trim().max(ACCESS_CODE_MAX_LENGTH, "A code, not a paragraph"),
  securityNotes: z.string().trim().max(TEXT_MAX),
  parkingRules: z.string().trim().max(TEXT_MAX),
  surfaceCare: z.string().trim().max(TEXT_MAX),
  doNots: z.string().trim().max(TEXT_MAX),
  rubbishDay: z.string().trim().max(TEXT_MAX),
  otherNotes: z.string().trim().max(TEXT_MAX),
});

type FormValues = z.infer<typeof formSchema>;

const BLANK: FormValues = {
  doorCode: "",
  gateCode: "",
  alarmCode: "",
  securityNotes: "",
  parkingRules: "",
  surfaceCare: "",
  doNots: "",
  rubbishDay: "",
  otherNotes: "",
};

/** The stored row as form text: null reads as an empty input. */
function toFormValues(facts: PropertyFacts | null | undefined): FormValues {
  if (!facts) return BLANK;
  return {
    doorCode: facts.doorCode ?? "",
    gateCode: facts.gateCode ?? "",
    alarmCode: facts.alarmCode ?? "",
    securityNotes: facts.securityNotes ?? "",
    parkingRules: facts.parkingRules ?? "",
    surfaceCare: facts.surfaceCare ?? "",
    doNots: facts.doNots ?? "",
    rubbishDay: facts.rubbishDay ?? "",
    otherNotes: facts.otherNotes ?? "",
  };
}

export default function HouseFactsCard({
  property,
  canManage,
}: {
  property: Property;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const factsKey = ["/api/properties", property.id, "facts"];

  const { data: facts, isLoading } = useQuery<PropertyFacts | null>({ queryKey: factsKey });

  // `values` rather than `defaultValues`: the row arrives after the form
  // mounts, and this keeps the inputs in step with it without a reset call.
  const values = useMemo(() => toFormValues(facts), [facts]);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), values });

  const save = useMutation({
    mutationFn: async (data: FormValues) => {
      // Blank inputs go up as blank; the server reads them as cleared.
      const response = await apiRequest("PUT", `/api/properties/${property.id}/facts`, data);
      return (await response.json()) as PropertyFacts;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: factsKey });
      toast({ title: "Saved", description: "The household sees this on their Resources page." });
    },
    onError: () => {
      toast({ title: "That did not save", variant: "destructive" });
    },
  });

  return (
    <Card data-testid="card-house-facts">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          What your household needs to know
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          The household leader and steward see everything in this card on their Resources page.
          Staff notes above stay with staff -- do not put anything here you would not say to the
          house.
        </p>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((data) => save.mutate(data))}
            className="space-y-6"
            data-testid="form-house-facts"
          >
            <fieldset disabled={!canManage || isLoading} className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-3">
                {ACCESS_CODES.map((code) => (
                  <FormField
                    key={code.key}
                    control={form.control}
                    name={code.key}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{code.label}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            autoComplete="off"
                            maxLength={ACCESS_CODE_MAX_LENGTH}
                            className="font-mono"
                            data-testid={`input-house-facts-${code.key}`}
                          />
                        </FormControl>
                        {/* The date is the point: a code nobody has rotated
                            is the realistic failure, not a breach. */}
                        <FormDescription data-testid={`text-house-facts-${code.key}-date`}>
                          {facts?.[code.stamp]
                            ? `Last changed ${formatDate(facts[code.stamp])}`
                            : "Never set"}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {HOUSE_FACT_TEXT_FIELDS.map((fact) => (
                  <FormField
                    key={fact.key}
                    control={form.control}
                    name={fact.key}
                    render={({ field }) => (
                      <FormItem className={fact.key === "otherNotes" ? "sm:col-span-2" : undefined}>
                        <FormLabel>{fact.label}</FormLabel>
                        <FormControl>
                          {fact.key === "rubbishDay" ? (
                            <Input
                              {...field}
                              placeholder={fact.hint}
                              data-testid={`input-house-facts-${fact.key}`}
                            />
                          ) : (
                            <Textarea
                              {...field}
                              rows={3}
                              placeholder={fact.hint}
                              data-testid={`input-house-facts-${fact.key}`}
                            />
                          )}
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
              </div>
            </fieldset>

            {canManage && (
              <Button
                type="submit"
                variant="primary"
                disabled={save.isPending || isLoading}
                data-testid="button-save-house-facts"
              >
                {save.isPending ? "Saving…" : "Save for the household"}
              </Button>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
