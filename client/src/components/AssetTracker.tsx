import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Wind, Tv, Sofa, Refrigerator, Droplet, MoreVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Asset } from "@shared/schema";

interface AssetTrackerProps {
  assets: Asset[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const assetIcons = {
  HVAC: Wind,
  Appliance: Refrigerator,
  Plumbing: Droplet,
  Electronics: Tv,
  Furniture: Sofa,
};

export default function AssetTracker({ assets, onEdit, onDelete }: AssetTrackerProps) {
  const fixedAssets = assets.filter((a) => a.type === "fixed");
  const movableAssets = assets.filter((a) => a.type === "movable");

  const AssetList = ({ items }: { items: Asset[] }) => (
    <div className="space-y-4">
      {items.map((asset) => {
        const Icon = assetIcons[asset.category as keyof typeof assetIcons] || Sofa;
        return (
          <Card key={asset.id} className="hover-elevate" data-testid={`card-asset-${asset.id}`}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 flex-1">
                  <div className="p-2 bg-muted rounded-md">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm" data-testid={`text-asset-name-${asset.id}`}>
                      {asset.name}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1">{asset.location}</p>
                    {asset.serialNumber && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        SN: {asset.serialNumber}
                      </p>
                    )}
                    {asset.lastServiced && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Last serviced: {asset.lastServiced.toLocaleDateString()}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" data-testid={`badge-age-${asset.id}`}>
                    {asset.ageInYears} {asset.ageInYears === 1 ? 'year' : 'years'}
                  </Badge>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" data-testid={`button-menu-${asset.id}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEdit?.(asset.id)}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onDelete?.(asset.id)} className="text-destructive">
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );

  return (
    <div>
      <Tabs defaultValue="fixed" className="w-full">
        <TabsList className="grid w-full grid-cols-2" data-testid="tabs-asset-type">
          <TabsTrigger value="fixed" data-testid="tab-fixed-assets">
            Fixed Assets ({fixedAssets.length})
          </TabsTrigger>
          <TabsTrigger value="movable" data-testid="tab-movable-assets">
            Movable Assets ({movableAssets.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="fixed" className="mt-6">
          <AssetList items={fixedAssets} />
        </TabsContent>
        <TabsContent value="movable" className="mt-6">
          <AssetList items={movableAssets} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
