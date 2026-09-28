import { Button } from "@/components/ui/button";
import { UserX } from "lucide-react";
import { Section, Container, PageStack } from "@/components/layout/page";

// What a deactivated account sees in place of either switch. Every data route
// refuses it, so showing the staff or resident screens would only render a
// page of empty states that look like "nothing here" rather than "not you".
export default function AccountInactive() {
  return (
    <Section className="min-h-[100dvh] flex items-center"><Container><PageStack className="mx-auto max-w-md text-center items-center">
      <UserX className="h-10 w-10 text-primary-strong" aria-hidden="true" />
      <h1 className="text-3xl font-semibold" data-testid="text-account-inactive">Your account has been deactivated</h1>
      <p className="text-muted-foreground">Contact your regional administrator if you think this is a mistake.</p>
      <Button
        variant="secondary"
        onClick={() => { window.location.href = "/api/logout"; }}
        data-testid="button-inactive-logout"
      >
        Sign out
      </Button>
    </PageStack></Container></Section>
  );
}
