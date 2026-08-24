import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Building2, Wrench, Camera, Package, Users } from "lucide-react";
import spoLogo from "@assets/SPO Logo under 600x600px_SPO Vertical - Ocean_1763138801065.png";
import { Section, Container, PageStack } from "@/components/layout/page";

const features = [
  {
    icon: Wrench,
    title: "Maintenance",
    description: "Track and manage maintenance requests efficiently",
  },
  {
    icon: Camera,
    title: "Walkthroughs",
    description: "Document property inspections with photos",
  },
  {
    icon: Package,
    title: "Asset Tracking",
    description: "Monitor fixed and movable property assets",
  },
  {
    icon: Users,
    title: "Contacts & Invoices",
    description: "Manage vendors, service providers, and resident billing",
  },
  {
    icon: Building2,
    title: "Multi-Property",
    description: "Organize and filter properties by region and chapter",
  },
];

export default function Landing() {
  return (
    <div className="min-h-[100dvh] bg-muted/30">
      <Section size="lg"><Container>
        <PageStack className="mx-auto flex max-w-4xl flex-col items-center">
          <div className="text-center">
            <img src={spoLogo} alt="SPO Logo" className="h-24 w-24 mx-auto mb-6 object-contain" />
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight mb-4">Property Management Portal</h1>
            <p className="text-xl text-muted-foreground mb-2">
              Saint Paul's Outreach, Inc.
            </p>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Streamline property operations with comprehensive management tools for maintenance, assets, billing, and more.
            </p>
          </div>

          <div className="flex flex-col items-center gap-3 py-4">
            <Button
              size="lg"
              onClick={() => window.location.href = "/api/login"}
              data-testid="button-login"
            >
              Sign In to Continue
            </Button>
            <p className="text-sm text-muted-foreground">
              Please contact your administrator if you need access.
            </p>
          </div>

          <Card className="w-full">
            <CardContent className="p-6 md:p-8">
              <h2 className="text-2xl font-semibold mb-6 text-center">Features</h2>
              {/* flex-wrap rather than a grid so the odd last row stays centered */}
              <div className="flex flex-wrap justify-center gap-6">
                {features.map(({ icon: Icon, title, description }) => (
                  <div key={title} className="flex w-56 flex-col items-center text-center p-4">
                    <div className="p-3 bg-primary/10 rounded-lg mb-3">
                      <Icon className="h-6 w-6 text-primary" />
                    </div>
                    <h3 className="font-semibold mb-2">{title}</h3>
                    <p className="text-sm text-muted-foreground">{description}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </PageStack>
      </Container></Section>
    </div>
  );
}
