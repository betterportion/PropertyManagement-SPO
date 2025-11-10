import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin } from "lucide-react";

interface RegionSelectorProps {
  selectedRegion: string;
  onRegionChange: (value: string) => void;
}

const regions = [
  { id: "all", name: "All Regions" },
  { id: "west-central", name: "West Central" },
  { id: "east-central", name: "East Central" },
  { id: "north-west", name: "North West" },
  { id: "south-west", name: "South West" },
  { id: "north-east", name: "North East" },
  { id: "south-east", name: "South East" },
];

export default function RegionSelector({ selectedRegion, onRegionChange }: RegionSelectorProps) {
  return (
    <Select value={selectedRegion} onValueChange={onRegionChange}>
      <SelectTrigger className="w-48" data-testid="select-region">
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
