import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ListChecks, AlertCircle } from "lucide-react";
import PhotoGallery from "./PhotoGallery";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { WalkthroughRoom, WalkthroughPhoto } from "@shared/schema";

interface RoomDetailDrawerProps {
  room: WalkthroughRoom | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
}

export default function RoomDetailDrawer({ room, open, onOpenChange, canManage }: RoomDetailDrawerProps) {
  const { toast } = useToast();
  const [selectedCondition, setSelectedCondition] = useState<string>("");

  const { data: photos = [], isLoading: photosLoading } = useQuery<WalkthroughPhoto[]>({
    queryKey: ['/api/walkthrough-photos/room', room?.id],
    enabled: !!room,
  });

  const updatePhotoMutation = useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes: string }) => {
      return await apiRequest('PATCH', `/api/walkthrough-photos/${id}`, { notes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/walkthrough-photos/room', room?.id] });
      toast({
        title: "Notes updated",
        description: "Photo notes have been saved successfully.",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update photo notes.",
      });
    },
  });

  const deletePhotoMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest('DELETE', `/api/walkthrough-photos/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/walkthrough-photos/room', room?.id] });
      toast({
        title: "Photo deleted",
        description: "Photo has been removed successfully.",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete photo.",
      });
    },
  });

  const handleUploadPhotos = () => {
    toast({
      title: "Upload feature",
      description: "Photo upload functionality will be implemented with a file picker.",
    });
  };

  const handleUpdatePhotoNotes = (id: string, notes: string) => {
    updatePhotoMutation.mutate({ id, notes });
  };

  const handleDeletePhoto = (id: string) => {
    deletePhotoMutation.mutate(id);
  };

  if (!room) return null;

  return (
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
                onUpload={handleUploadPhotos}
                onDelete={handleDeletePhoto}
                onUpdateCaption={handleUpdatePhotoNotes}
              />
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
