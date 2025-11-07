import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Wrench, DollarSign, Package } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  description?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

function StatCard({ title, value, icon, description }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`stat-${title.toLowerCase().replace(/\s/g, "-")}`}>
          {value}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

interface DashboardStatsProps {
  stats: {
    totalProperties: number;
    activeRequests: number;
    pendingInvoices: number;
    totalAssets: number;
  };
}

export default function DashboardStats({ stats }: DashboardStatsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Total Properties"
        value={stats.totalProperties}
        icon={<Building2 className="h-4 w-4" />}
        description="Active properties"
      />
      <StatCard
        title="Active Requests"
        value={stats.activeRequests}
        icon={<Wrench className="h-4 w-4" />}
        description="Maintenance requests"
      />
      <StatCard
        title="Pending Invoices"
        value={stats.pendingInvoices}
        icon={<DollarSign className="h-4 w-4" />}
        description="Awaiting payment"
      />
      <StatCard
        title="Total Assets"
        value={stats.totalAssets}
        icon={<Package className="h-4 w-4" />}
        description="Tracked items"
      />
    </div>
  );
}
