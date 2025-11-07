import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2 } from "lucide-react";

interface PropertySelectorProps {
  selectedProperty: string;
  onPropertyChange: (value: string) => void;
  properties: Array<{ id: string; name: string; address: string }>;
}

export default function PropertySelector({ selectedProperty, onPropertyChange, properties }: PropertySelectorProps) {
  return (
    <Select value={selectedProperty} onValueChange={onPropertyChange}>
      <SelectTrigger className="w-64" data-testid="select-property">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          <SelectValue placeholder="Select property" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {properties.map((property) => (
          <SelectItem key={property.id} value={property.id} data-testid={`option-property-${property.id}`}>
            <div>
              <div className="font-medium">{property.name}</div>
              <div className="text-xs text-muted-foreground">{property.address}</div>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
