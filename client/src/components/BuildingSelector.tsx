import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2 } from "lucide-react";

interface BuildingSelectorProps {
  selectedBuilding: string;
  onBuildingChange: (value: string) => void;
  buildings: { id: string; address: string }[];
}

export default function BuildingSelector({ selectedBuilding, onBuildingChange, buildings }: BuildingSelectorProps) {
  return (
    <Select value={selectedBuilding} onValueChange={onBuildingChange}>
      <SelectTrigger className="w-64" data-testid="select-building">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          <SelectValue placeholder="Select building" />
        </div>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all" data-testid="option-building-all">
          All Buildings
        </SelectItem>
        {buildings.map((building) => (
          <SelectItem key={building.id} value={building.id} data-testid={`option-building-${building.id}`}>
            {building.address}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
