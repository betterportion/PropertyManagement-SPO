import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin } from "lucide-react";
import { REGIONS } from "@shared/regions";

interface RegionSelectorProps {
  selectedRegion: string;
  onRegionChange: (value: string) => void;
}

// The value is the region exactly as it is stored on records ("Northwest"), so a
// page can filter with `record.region === selectedRegion` directly.
const regions = [{ id: "all", name: "All Regions" }, ...REGIONS.map((r) => ({ id: r, name: r }))];

export default function RegionSelector({ selectedRegion, onRegionChange }: RegionSelectorProps) {
  return (
    <Select value={selectedRegion} onValueChange={onRegionChange}>
      <SelectTrigger className="w-full min-w-48 sm:w-48" data-testid="select-region" aria-label="Filter by region">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4" />
          <SelectValue placeholder="Select region" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {regions.map((region) => (
          <SelectItem key={region.id} value={region.id} data-testid={`option-region-${region.id}`}>
            {region.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
