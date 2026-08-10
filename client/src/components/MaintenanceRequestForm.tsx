import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Wrench } from "lucide-react";

interface MaintenanceRequestFormProps {
  onSubmit?: (data: any) => void | Promise<void>;
  isSubmitting?: boolean;
}

export default function MaintenanceRequestForm({
  onSubmit,
  isSubmitting = false,
}: MaintenanceRequestFormProps) {
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    category: "",
    priority: "",
    location: "",
  });
  const update = (key: string, value: string) => setFormData((current) => ({ ...current, [key]: value }));
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit?.(formData);
    setFormData({ title: "", description: "", category: "", priority: "", location: "" });
  };
  return <Card className="border-border/80"><CardHeader><CardTitle className="flex items-center gap-2 text-xl"><Wrench className="h-5 w-5" />Submit maintenance request</CardTitle></CardHeader><CardContent>
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2"><Label htmlFor="title">Issue title</Label><Input id="title" placeholder="Brief description of the issue" value={formData.title} onChange={(e) => update("title", e.target.value)} required /></div>
      <div className="space-y-2"><Label htmlFor="location">Location</Label><Input id="location" placeholder="e.g., Unit 204, Kitchen" value={formData.location} onChange={(e) => update("location", e.target.value)} required /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="category">Category</Label><Select value={formData.category} onValueChange={(v) => update("category", v)}><SelectTrigger id="category"><SelectValue placeholder="Select category" /></SelectTrigger><SelectContent>{["plumbing","electrical","hvac","appliance","structural","other"].map((v) => <SelectItem key={v} value={v}>{v[0].toUpperCase()+v.slice(1)}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor="priority">Priority</Label><Select value={formData.priority} onValueChange={(v) => update("priority", v)}><SelectTrigger id="priority"><SelectValue placeholder="Select priority" /></SelectTrigger><SelectContent>{["low","medium","high","urgent"].map((v) => <SelectItem key={v} value={v}>{v[0].toUpperCase()+v.slice(1)}</SelectItem>)}</SelectContent></Select></div>
      </div>
      <div className="space-y-2"><Label htmlFor="description">Description</Label><Textarea id="description" placeholder="Detailed description of the issue" value={formData.description} onChange={(e) => update("description", e.target.value)} rows={4} required /></div>
      <Button type="submit" variant="primary" className="w-full" disabled={isSubmitting}>{isSubmitting ? "Sending request..." : "Submit request"}</Button>
    </form>
  </CardContent></Card>;
}