import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhotoUpload } from "@/components/PhotoUpload";
import { Wrench, X } from "lucide-react";

const MAX_PHOTOS = 5;

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
  const [error, setError] = useState("");
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  // Bumped after each upload so the dropzone resets to empty for the next photo.
  const [uploadKey, setUploadKey] = useState(0);
  const update = (key: string, value: string) => setFormData((current) => ({ ...current, [key]: value }));
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Category and priority are required by the server; validate here so the
    // resident sees why rather than a rejected request. The form is not cleared
    // on error, so their description is not lost.
    if (!formData.category || !formData.priority) {
      setError("Please choose a category and a priority.");
      return;
    }
    setError("");
    onSubmit?.({ ...formData, photoUrls });
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
      <div className="space-y-2">
        <Label>Photos <span className="text-muted-foreground text-xs">(optional — up to {MAX_PHOTOS})</span></Label>
        {photoUrls.length > 0 && (
          <div className="grid grid-cols-3 gap-2" data-testid="request-photo-thumbs">
            {photoUrls.map((url) => (
              <div key={url} className="relative">
                <img src={url} alt="Attached to the request" className="h-24 w-full rounded-md border object-cover" />
                <Button
                  type="button" size="icon" variant="destructive"
                  className="absolute right-1 top-1 h-6 w-6"
                  onClick={() => setPhotoUrls((u) => u.filter((x) => x !== url))}
                  aria-label="Remove photo"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {photoUrls.length < MAX_PHOTOS && (
          <PhotoUpload
            key={uploadKey}
            endpoint="/api/maintenance-request-photos/upload"
            onUpload={(url) => { setPhotoUrls((u) => [...u, url]); setUploadKey((k) => k + 1); }}
            onError={(msg) => setError(msg)}
          />
        )}
      </div>
      {error && <p className="text-sm text-destructive" data-testid="text-form-error">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={isSubmitting} data-testid="button-submit-request">{isSubmitting ? "Sending request..." : "Submit request"}</Button>
    </form>
  </CardContent></Card>;
}