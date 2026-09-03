import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "wouter";
import { AlarmClock, Wind, Tv, Sofa, Refrigerator, Droplet, MoreVertical, Camera, Building2, MapPin } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Asset, Property } from "@shared/schema";
import { EmptyState } from "@/components/states";
import { formatDate, formatCurrency } from "@/lib/format";
import LifecycleBadge from "@/components/asset/LifecycleBadge";

interface AssetTrackerProps {
  assets: Asset[];
  properties: Property[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onPhotos?: (id: string) => void;
  /** Opens the snooze dialog. Omitted for a caller who cannot manage assets. */
  onSnooze?: (id: string) => void;
  /** "list" (default) or the photo-first "gallery" grid. */
  view?: "list" | "gallery";
  /** assetId → cover photo URL, used by the gallery view. */
  coverPhotos?: Record<string, string>;
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
  onSnooze?: (id: string) => void;
}

/**
 * Deliberately declared here rather than inside AssetTracker.
 *
 * A component defined during a render is a brand new component type on every
 * render, so React throws the previous one away and mounts this one from
 * scratch. In practice that closed any open row menu and dropped scroll
 * position whenever the parent re-rendered.
 */
function AssetList({ items, properties, onEdit, onDelete, onPhotos, onSnooze }: AssetListProps) {
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
                    <h4 className="font-medium text-sm">
                      <Link
                        href={`/assets/${asset.id}`}
                        className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`text-asset-name-${asset.id}`}
                      >
                        {asset.name}
                      </Link>
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
                  {/* A snoozed asset still appears here, and says it is
                      snoozed. Only the dashboard hides one -- hiding it
                      everywhere is how a boiler gets forgotten. */}
                  <LifecycleBadge asset={asset} />
                  <Badge variant="secondary" data-testid={`badge-age-${asset.id}`}>
                    {asset.type === "fixed" ? `${asset.ageInYears} ${asset.ageInYears === 1 ? "year" : "years"}` : formatCurrency(asset.purchasePrice)}
                  </Badge>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" data-testid={`button-menu-${asset.id}`} aria-label={`Actions for ${asset.name}`}>
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
                      {onSnooze && (
                        <DropdownMenuItem onClick={() => onSnooze(asset.id)}>
                          <AlarmClock className="h-4 w-4 mr-2" />
                          Snooze
                        </DropdownMenuItem>
                      )}
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

interface AssetGalleryProps {
  items: Asset[];
  properties: Property[];
  coverPhotos: Record<string, string>;
  onPhotos?: (id: string) => void;
}

/**
 * Marketplace-style photo grid: square cover photo, then name / price-or-age /
 * property in that order. Clicking a tile opens the asset's photo dialog.
 */
function AssetGallery({ items, properties, coverPhotos, onPhotos }: AssetGalleryProps) {
  if (items.length === 0) {
    return (
      <EmptyState title="This asset list is clear" description="Assets added to this category will appear here with their property and service details." />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((asset) => {
        const Icon = assetIcons[asset.category as keyof typeof assetIcons] || Sofa;
        const property = getPropertyForAsset(asset, properties);
        const cover = coverPhotos[asset.id];
        const place = [property?.name ?? asset.buildingAddress, asset.location]
          .filter(Boolean)
          .join(" · ");
        return (
          <button
            key={asset.id}
            type="button"
            onClick={() => onPhotos?.(asset.id)}
            className="group text-left focus-visible:outline-none"
            data-testid={`tile-asset-${asset.id}`}
          >
            <div className="aspect-square overflow-hidden rounded-lg border border-border bg-muted transition-shadow group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring dark:group-hover:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_2px_16px_rgba(255,255,255,0.08)]">
              {cover ? (
                <img src={cover} alt={asset.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Icon className="h-10 w-10 text-muted-foreground" />
                </div>
              )}
            </div>
            <p className="mt-2 truncate font-medium" data-testid={`text-asset-name-${asset.id}`}>
              {asset.name}
            </p>
            <p className="text-sm">
              {asset.type === "fixed"
                ? `${asset.ageInYears} ${asset.ageInYears === 1 ? "year" : "years"} old`
                : formatCurrency(asset.purchasePrice)}
            </p>
            {place && <p className="truncate text-sm text-muted-foreground">{place}</p>}
          </button>
        );
      })}
    </div>
  );
}

export default function AssetTracker({
  assets,
  properties,
  onEdit,
  onDelete,
  onPhotos,
  onSnooze,
  view = "list",
  coverPhotos = {},
}: AssetTrackerProps) {
  const fixedAssets = assets.filter((a) => a.type === "fixed");
  const movableAssets = assets.filter((a) => a.type === "movable");
  const listProps = { properties, onEdit, onDelete, onPhotos, onSnooze };

  const renderItems = (items: Asset[]) =>
    view === "gallery" ? (
      <AssetGallery items={items} properties={properties} coverPhotos={coverPhotos} onPhotos={onPhotos} />
    ) : (
      <AssetList items={items} {...listProps} />
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
          {renderItems(fixedAssets)}
        </TabsContent>
        <TabsContent value="movable" className="mt-6">
          {renderItems(movableAssets)}
        </TabsContent>
      </Tabs>
    </div>
  );
}
