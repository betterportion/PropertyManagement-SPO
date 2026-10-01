import { useMutation, useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDateTime } from "@/lib/format";
import { serverMessage } from "@/lib/serverMessage";
import { EMAIL_TEMPLATES, type EmailTemplate } from "@shared/emailTemplates";

interface EmailStats {
  configured: boolean;
  byTemplate: Array<{ template: string; label: string; sent: number; failed: number; notConfigured: number }>;
  recentFailures: Array<{ id: string; template: string; recipient: string; errorClass: string | null; createdAt: string }>;
}

const KEY = "/api/email-health";

/**
 * Are the automated emails actually going out? Admins only. The last 30 days
 * by email, the recent failures, and a test send to yourself. The log keeps
 * which email, to whom and whether it went -- never what it said.
 */
export default function EmailHealthSettings() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<EmailStats>({ queryKey: [KEY] });

  const test = useMutation({
    mutationFn: async () => (await (await apiRequest("POST", `${KEY}/test`)).json()) as { sent: boolean; reason?: string },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [KEY] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
      if (result.sent) toast({ title: "Test email sent", description: "Check your inbox (and spam) in a minute." });
      else if (result.reason === "not_configured") toast({ title: "Email isn't set up yet", description: "Nothing was sent.", variant: "destructive" });
      else toast({ title: "The test email failed", description: "See the failures below.", variant: "destructive" });
    },
    onError: (error) => toast({ title: "The test did not run", description: serverMessage(error), variant: "destructive" }),
  });

  return (
    <Card id="email-health" data-testid="card-email-health">
      <CardHeader>
        <CardTitle>Email health</CardTitle>
        <p className="text-sm text-muted-foreground">
          Every automated email the portal tried to send in the last 30 days, and whether it went. Delivery past the mail
          provider (bounces, spam folders) isn't tracked yet.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading || !data ? (
          <LoadingState />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              {data.configured ? (
                <Badge variant="success">Email is set up</Badge>
              ) : (
                <Badge variant="warning">Email isn't set up: nothing is being sent</Badge>
              )}
              <Button variant="secondary" size="sm" onClick={() => test.mutate()} disabled={test.isPending} data-testid="button-email-test">
                <Send className="mr-1 h-4 w-4" /> Send a test email to me
              </Button>
            </div>

            {data.byTemplate.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-email-none">
                No automated emails in the last 30 days.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-email-health">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-normal">Email</th>
                      <th className="py-1 pr-3 text-right font-normal">Sent</th>
                      <th className="py-1 pr-3 text-right font-normal">Failed</th>
                      <th className="py-1 text-right font-normal">Not sent (not set up)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.byTemplate.map((row) => (
                      <tr key={row.template}>
                        <td className="py-1 pr-3">{row.label}</td>
                        <td className="py-1 pr-3 text-right">{row.sent}</td>
                        <td className={`py-1 pr-3 text-right ${row.failed > 0 ? "font-medium text-destructive" : ""}`}>{row.failed}</td>
                        <td className="py-1 text-right">{row.notConfigured}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data.recentFailures.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-medium">Recent failures</h3>
                <ul className="divide-y rounded-md border text-sm">
                  {data.recentFailures.map((f) => (
                    <li key={f.id} className="flex flex-wrap justify-between gap-2 p-2">
                      <span>
                        {EMAIL_TEMPLATES[f.template as EmailTemplate] ?? f.template} to {f.recipient}
                        {f.errorClass ? <span className="text-muted-foreground"> · {f.errorClass}</span> : null}
                      </span>
                      <span className="text-muted-foreground">{formatDateTime(f.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
