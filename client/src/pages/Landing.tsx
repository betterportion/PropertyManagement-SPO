import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Building2, Wrench, Camera, Package, Users } from "lucide-react";
import spoLogo from "@assets/SPO Logo under 600x600px_SPO Vertical - Ocean_1763138801065.png";
import { Section, Container, PageStack } from "@/components/layout/page";

export default function Landing() {
  return (
    <div className="min-h-[100dvh] bg-muted/30">
      <Section size="lg"><Container><PageStack className="items-center">
          <div className="text-center mb-12">
            <img src={spoLogo} alt="SPO Logo" className="h-24 w-24 mx-auto mb-6 object-contain" />
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight mb-4">Property Management Portal</h1>
            <p className="text-xl text-muted-foreground mb-2">
              Saint Paul's Outreach, Inc.
            </p>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Streamline property operations with comprehensive management tools for maintenance, assets, billing, and more.
            </p>
          </div>

          <Card className="max-w-4xl w-full">
            <CardContent className="p-6 md:p-8">
            <h2 className="text-2xl font-semibold mb-6 text-center">Features</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="flex flex-col items-center text-center p-4">
                <div className="p-3 bg-primary/10 rounded-lg mb-3">
                  <Wrench className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold mb-2">Maintenance</h3>
                <p className="text-sm text-muted-foreground">
                  Track and manage maintenance requests efficiently
                </p>
              </div>

              <div className="flex flex-col items-center text-center p-4">
                <div className="p-3 bg-primary/10 rounded-lg mb-3">
                  <Camera className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold mb-2">Walkthroughs</h3>
                <p className="text-sm text-muted-foreground">
                  Document property inspections with photos
                </p>
              </div>

              <div className="flex flex-col items-center text-center p-4">
                <div className="p-3 bg-primary/10 rounded-lg mb-3">
                  <Package className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold mb-2">Asset Tracking</h3>
                <p className="text-sm text-muted-foreground">
                  Monitor fixed and movable property assets
                </p>
              </div>

              <div className="flex flex-col items-center text-center p-4">
                <div className="p-3 bg-primary/10 rounded-lg mb-3">
                  <Users className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold mb-2">Maint Contacts & Invoices</h3>
                <p className="text-sm text-muted-foreground">
                  Manage vendors, service providers, and resident billing
                </p>
              </div>

              <div className="flex flex-col items-center text-center p-4">
                <div className="p-3 bg-primary/10 rounded-lg mb-3">
                  <Building2 className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold mb-2">Multi-Property</h3>
                <p className="text-sm text-muted-foreground">
                  Filter by region and building address
                </p>
              </div>
            </div>
            </CardContent>
          </Card>

          <div className="flex flex-col items-center gap-4">
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
      </PageStack></Container></Section>
    </div>
  );
}
