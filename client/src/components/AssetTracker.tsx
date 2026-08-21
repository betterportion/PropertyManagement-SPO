import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Wind, Tv, Sofa, Refrigerator, Droplet, MoreVertical, Camera, Building2, MapPin } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Asset, Property } from "@shared/schema";
import { EmptyState } from "@/components/states";
import { formatDate, formatCurrency } from "@/lib/format";

interface AssetTrackerProps {
  assets: Asset[];
  properties: Property[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onPhotos?: (id: string) => void;
}

const assetIcons = {
  HVAC: Wind,
  Appliance: Refrigerator,
  Plumbing: Droplet,
  Electronics: Tv,
  Furniture: Sofa,
};

function getPropertyForAsset(asset: Asset, properties: Property[]) {
  if (asset.propertyId) {
    return properties.find(p => p.id === asset.propertyId) || null;
  }
  return properties.find(p => p.address === asset.buildingAddress) || null;
}

interface AssetListProps {
  items: Asset[];
  properties: Property[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onPhotos?: (id: string) => void;
}

/**
 * Deliberately declared here rather than inside AssetTracker.
 *
 * A component defined during a render is a brand new component type on every
 * render, so React throws the previous one away and mounts this one from
 * scratch. In practice that closed any open row menu and dropped scroll
 * position whenever the parent re-rendered.
 */
function AssetList({ items, properties, onEdit, onDelete, onPhotos }: AssetListProps) {
  return (
    <div className="space-y-4">
      {items.length === 0 ? (
        <EmptyState title="This asset list is clear" description="Assets added to this category will appear here with their property and service details." />
      ) : items.map((asset) => {
        const Icon = assetIcons[asset.category as keyof typeof assetIcons] || Sofa;
        const property = getPropertyForAsset(asset, properties);
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
                    {property ? (
                      <>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                          <Building2 className="h-3 w-3" />
                          <span className="font-medium">{property.name}</span>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <MapPin className="h-3 w-3" />
                          <span>{property.address}</span>
                        </div>
                        <Badge variant="secondary" className="text-xs mt-1" data-testid={`badge-region-${asset.id}`}>
                          {property.region}
                        </Badge>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-1">{asset.buildingAddress}</p>
                    )}
                    {asset.location && (
                      <p className="text-xs text-muted-foreground mt-0.5">Location: {asset.location}</p>
                    )}
                    {asset.serialNumber && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        SN: {asset.serialNumber}
                      </p>
                    )}
                    {asset.lastServiced && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Last serviced: {formatDate(asset.lastServiced)}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" data-testid={`badge-age-${asset.id}`}>
                    {asset.type === "fixed" ? `${asset.ageInYears} ${asset.ageInYears === 1 ? "year" : "years"}` : formatCurrency(asset.purchasePrice)}
                  </Badge>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" data-testid={`button-menu-${asset.id}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onPhotos?.(asset.id)}>
                        <Camera className="h-4 w-4 mr-2" />
                        Photos
                      </DropdownMenuItem>
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
}

export default function AssetTracker({ assets, properties, onEdit, onDelete, onPhotos }: AssetTrackerProps) {
  const fixedAssets = assets.filter((a) => a.type === "fixed");
  const movableAssets = assets.filter((a) => a.type === "movable");
  const listProps = { properties, onEdit, onDelete, onPhotos };

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
          <AssetList items={fixedAssets} {...listProps} />
        </TabsContent>
        <TabsContent value="movable" className="mt-6">
          <AssetList items={movableAssets} {...listProps} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
