import { useState } from "react";
import RegionSelector from "../RegionSelector";

export default function RegionSelectorExample() {
  const [selected, setSelected] = useState("all");

  return (
    <RegionSelector 
      selectedRegion={selected} 
      onRegionChange={setSelected}
    />
  );
}
