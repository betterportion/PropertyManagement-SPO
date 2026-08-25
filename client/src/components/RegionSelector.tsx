import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin } from "lucide-react";

interface RegionSelectorProps {
  selectedRegion: string;
  onRegionChange: (value: string) => void;
}

// The value is the region exactly as it is stored on records ("West Central"),
// so a page can filter with `record.region === selectedRegion` directly. Earlier
// these were kebab-case ids, which silently matched nothing on the pages that
// compared against the stored Title Case value.
const regions = [
  { id: "all", name: "All Regions" },
  { id: "West Central", name: "West Central" },
  { id: "East Central", name: "East Central" },
  { id: "North West", name: "North West" },
  { id: "South West", name: "South West" },
  { id: "North East", name: "North East" },
  { id: "South East", name: "South East" },
];

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
