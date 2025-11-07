import MaintenanceRequestForm from "../MaintenanceRequestForm";

export default function MaintenanceRequestFormExample() {
  return (
    <MaintenanceRequestForm 
      onSubmit={(data) => console.log("Form submitted:", data)}
    />
  );
}
