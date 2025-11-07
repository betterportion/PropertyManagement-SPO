import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DollarSign, Calendar, User } from "lucide-react";

interface Resident {
  id: string;
  name: string;
  unit: string;
  email: string;
  phone: string;
  moveInDate: Date;
  rentAmount: number;
}

interface BillingRecord {
  id: string;
  residentId: string;
  description: string;
  amount: number;
  dueDate: Date;
  status: "paid" | "pending" | "overdue";
}

interface ResidentBillingProps {
  residents: Resident[];
  billingRecords: BillingRecord[];
  onAddBilling?: (residentId: string) => void;
  onViewResident?: (id: string) => void;
}

const statusColors = {
  paid: "bg-chart-2 text-white",
  pending: "bg-chart-4 text-white",
  overdue: "bg-destructive text-destructive-foreground",
};

export default function ResidentBilling({ residents, billingRecords, onAddBilling, onViewResident }: ResidentBillingProps) {
  const getResidentBilling = (residentId: string) => {
    return billingRecords.filter((record) => record.residentId === residentId);
  };

  const getInitials = (name: string) => {
    return name.split(" ").map((n) => n[0]).join("").toUpperCase();
  };

  return (
    <div className="space-y-6">
      {residents.map((resident) => {
        const billing = getResidentBilling(resident.id);
        const totalDue = billing
          .filter((b) => b.status !== "paid")
          .reduce((sum, b) => sum + b.amount, 0);

        return (
          <Card key={resident.id} className="hover-elevate" data-testid={`card-resident-${resident.id}`}>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Avatar>
                    <AvatarFallback>{getInitials(resident.name)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <CardTitle className="text-lg" data-testid={`text-resident-name-${resident.id}`}>
                      {resident.name}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">{resident.unit}</p>
                    <div className="flex flex-wrap gap-3 mt-2 text-xs text-muted-foreground">
                      <span>{resident.email}</span>
                      <span>{resident.phone}</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Monthly Rent</p>
                  <p className="text-xl font-semibold">${resident.rentAmount}</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium text-sm">Billing Records</h4>
                  <Button 
                    size="sm" 
                    variant="outline"
                    onClick={() => onAddBilling?.(resident.id)}
                    data-testid={`button-add-billing-${resident.id}`}
                  >
                    Add Charge
                  </Button>
                </div>

                {billing.length > 0 ? (
                  <div className="space-y-2">
                    {billing.map((record) => (
                      <div 
                        key={record.id} 
                        className="flex items-center justify-between p-3 bg-muted rounded-md"
                        data-testid={`item-billing-${record.id}`}
                      >
                        <div className="flex-1">
                          <p className="text-sm font-medium">{record.description}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                            <Calendar className="h-3 w-3" />
                            Due {record.dueDate.toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <p className="text-sm font-semibold">${record.amount}</p>
                          <Badge className={statusColors[record.status]} data-testid={`badge-billing-status-${record.id}`}>
                            {record.status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                    {totalDue > 0 && (
                      <div className="pt-2 border-t flex items-center justify-between">
                        <p className="text-sm font-medium">Total Due</p>
                        <p className="text-lg font-semibold text-destructive">${totalDue}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No billing records
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
