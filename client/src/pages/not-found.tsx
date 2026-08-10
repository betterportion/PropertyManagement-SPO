import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { Section, Container, PageStack } from "@/components/layout/page";

export default function NotFound() {
  return (
    <Section className="min-h-[100dvh] flex items-center"><Container><PageStack className="mx-auto max-w-md text-center items-center">
      <AlertCircle className="h-10 w-10 text-primary-strong" aria-hidden="true" />
      <h1 className="text-3xl font-semibold">This page is not available</h1>
      <p className="text-muted-foreground">The address may be out of date. Return to the portal and continue from there.</p>
      <Link href="/"><Button variant="secondary">Return to portal</Button></Link>
    </PageStack></Container></Section>
  );
}
