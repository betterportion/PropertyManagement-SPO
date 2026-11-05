import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { DEEP_CLEAN_AREAS, DEEP_CLEAN_INTRO } from "@shared/deepClean";

/** SPO's deep cleaning instructions, room by room, from the Resources page. */
export default function DeepCleanGuide() {
  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <Link
            href="/resources"
            className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="link-deep-clean-back"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Resources
          </Link>
          <PageHeader title="Deep cleaning instructions" description="Household program. What has to be cleaned before you move out, room by room." />

          <Card data-testid="card-deep-clean-goal">
            <CardHeader>
              <CardTitle>The goal</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed">
              {DEEP_CLEAN_INTRO.map((paragraph) => (
                <p key={paragraph.slice(0, 24)}>{paragraph}</p>
              ))}
            </CardContent>
          </Card>

          {DEEP_CLEAN_AREAS.map(({ area, groups }) => (
            <Card key={area} data-testid={`card-deep-clean-${area.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
              <CardHeader>
                <CardTitle>{area}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5 text-sm leading-relaxed">
                {groups.map((group, i) => (
                  <div key={group.heading ?? i} className="space-y-2">
                    {group.heading && <h3 className="font-semibold">{group.heading}</h3>}
                    <ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
                      {group.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    {group.note && (
                      <p className="rounded-lg bg-muted px-3 py-2 text-muted-foreground">
                        <span className="font-semibold text-foreground">Note:</span> {group.note}
                      </p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </PageStack>
      </Container>
    </Section>
  );
}
