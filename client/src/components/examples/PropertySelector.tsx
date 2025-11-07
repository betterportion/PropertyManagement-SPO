import { useState } from "react";
import PropertySelector from "../PropertySelector";

export default function PropertySelectorExample() {
  const [selected, setSelected] = useState("1");
  
  const properties = [
    { id: "1", name: "Sunset Apartments", address: "123 Main St, Austin, TX" },
    { id: "2", name: "Oak Ridge Complex", address: "456 Oak Ave, Austin, TX" },
    { id: "3", name: "River View Condos", address: "789 River Rd, Austin, TX" },
  ];

  return (
    <PropertySelector 
      selectedProperty={selected} 
      onPropertyChange={setSelected}
      properties={properties}
    />
  );
}
