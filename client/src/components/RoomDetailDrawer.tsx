import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ListChecks, AlertCircle } from "lucide-react";
import PhotoGallery from "./PhotoGallery";
import { PhotoUpload } from "./PhotoUpload";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { WalkthroughRoom, WalkthroughPhoto, Property } from "@shared/schema";

interface RoomDetailDrawerProps {
  room: WalkthroughRoom | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
}

const CONDITIONS = ["excellent", "good", "fair", "poor", "damaged"] as const;

export default function RoomDetailDrawer({ room, open, onOpenChange, canManage }: RoomDetailDrawerProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const typedUser = user as any;

  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [condition, setCondition] = useState<string>("good");
  const [notes, setNotes] = useState<string>("");
  const [location, setLocation] = useState<string>("");

  const { data: photos = [], isLoading: photosLoading } = useQuery<WalkthroughPhoto[]>({
    queryKey: ['/api/walkthrough-photos/room', room?.id],
    enabled: !!room,
  });

  const { data: properties = [] } = useQuery<Property[]>({
    queryKey: ['/api/properties'],
  });

  const getRegionForRoom = () => {
    if (!room) return "";
    if (room.propertyId) {
      const prop = properties.find(p => p.id === room.propertyId);
      if (prop) return prop.region;
    }
    const prop = properties.find(p => p.address === room.buildingAddress);
    return prop?.region || "";
  };

  const createPhotoMutation = useMutation({
    mutationFn: async (data: any) => {
      return await apiRequest('POST', '/api/walkthrough-photos', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/walkthrough-photos/room', room?.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/walkthrough-photos'] });
      setIsUploadDialogOpen(false);
      resetUploadDialog();
      toast({ title: "Photo uploaded", description: "Photo saved successfully." });
    },
    onError: () => {
      toast({ variant: "destructive", title: "Error", description: "Failed to save photo." });
    },
  });

  const updatePhotoMutation = useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes: string }) => {
      return await apiRequest('PATCH', `/api/walkthrough-photos/${id}`, { notes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/walkthrough-photos/room', room?.id] });
      toast({ title: "Notes updated", description: "Photo notes have been saved successfully." });
    },
    onError: () => {
      toast({ variant: "destructive", title: "Error", description: "Failed to update photo notes." });
    },
  });

  const deletePhotoMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest('DELETE', `/api/walkthrough-photos/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/walkthrough-photos/room', room?.id] });
      toast({ title: "Photo deleted", description: "Photo has been removed successfully." });
    },
    onError: () => {
      toast({ variant: "destructive", title: "Error", description: "Failed to delete photo." });
    },
  });

  const resetUploadDialog = () => {
    setUploadedUrl(null);
    setCondition("good");
    setNotes("");
    setLocation("");
  };

  const handleOpenUploadDialog = () => {
    setLocation(room?.name || "");
    setIsUploadDialogOpen(true);
  };

  const handleSubmitPhoto = () => {
    if (!room || !uploadedUrl) {
      toast({ variant: "destructive", title: "Missing photo", description: "Please upload a photo first." });
      return;
    }
    if (!condition) {
      toast({ variant: "destructive", title: "Missing condition", description: "Please select a condition." });
      return;
    }

    createPhotoMutation.mutate({
      roomId: room.id,
      imageUrl: uploadedUrl,
      condition,
      notes: notes || undefined,
      region: getRegionForRoom(),
      buildingAddress: room.buildingAddress,
      location: location || room.name,
      uploadedBy: typedUser?.email || typedUser?.claims?.email || "",
    });
  };

  if (!room) return null;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader className="pb-4">
            <SheetTitle className="text-2xl">{room.name}</SheetTitle>
            <p className="text-sm text-muted-foreground">{room.buildingAddress}</p>
          </SheetHeader>

          <div className="space-y-6 py-4">
            {room.requiredQuestions && room.requiredQuestions.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <ListChecks className="h-5 w-5 text-muted-foreground" />
                  <h3 className="font-semibold">Required Questions</h3>
                </div>
                <div className="space-y-2 pl-7">
                  {room.requiredQuestions.map((question, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5">{index + 1}</Badge>
                      <p className="text-sm text-muted-foreground">{question}</p>
                    </div>
                  ))}
                </div>
                <div className="pl-7 pt-2">
                  <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-md">
                    <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-muted-foreground">
                      These questions should be answered during the walkthrough. Notes can be added to individual photos below.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <Separator />

            <div className="space-y-3">
              <h3 className="font-semibold">Room Photos</h3>
              {photosLoading ? (
                <p className="text-sm text-muted-foreground">Loading photos...</p>
              ) : (
                <PhotoGallery
                  photos={photos}
                  canManage={canManage}
                  onUpload={handleOpenUploadDialog}
                  onDelete={(id) => deletePhotoMutation.mutate(id)}
                  onUpdateCaption={(id, notes) => updatePhotoMutation.mutate({ id, notes })}
                />
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={isUploadDialogOpen} onOpenChange={(open) => { setIsUploadDialogOpen(open); if (!open) resetUploadDialog(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Photo — {room.name}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <PhotoUpload
              onUpload={(url) => setUploadedUrl(url)}
              onError={(msg) => toast({ variant: "destructive", title: "Upload error", description: msg })}
              data-testid="room-photo-upload"
            />

            <div className="space-y-2">
              <Label>Condition</Label>
              <Select value={condition} onValueChange={setCondition}>
                <SelectTrigger data-testid="select-photo-condition">
                  <SelectValue placeholder="Select condition" />
                </SelectTrigger>
                <SelectContent>
                  {CONDITIONS.map((c) => (
                    <SelectItem key={c} value={c} className="capitalize">{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Location <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Unit 101, bedroom, hallway…"
                data-testid="input-photo-location"
              />
            </div>

            <div className="space-y-2">
              <Label>Notes <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add any relevant notes about this photo…"
                data-testid="input-photo-notes"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setIsUploadDialogOpen(false); resetUploadDialog(); }}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmitPhoto}
              disabled={!uploadedUrl || createPhotoMutation.isPending}
              data-testid="button-save-photo"
            >
              {createPhotoMutation.isPending ? "Saving…" : "Save Photo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
