import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Building2, DoorOpen, ListChecks, ImageIcon } from "lucide-react";
import type { WalkthroughRoom, WalkthroughPhoto } from "@shared/schema";

interface RoomCardProps {
  room: WalkthroughRoom;
  photo?: WalkthroughPhoto | null;
  onClick: () => void;
}

export default function RoomCard({ room, photo, onClick }: RoomCardProps) {
  const questionCount = room.requiredQuestions?.length || 0;

  return (
    <Card 
      className="hover-elevate active-elevate-2 cursor-pointer"
      onClick={onClick}
      data-testid={`card-room-${room.id}`}
    >
      <div className="flex">
        <div className="w-20 h-20 flex-shrink-0 bg-muted rounded-l-lg overflow-hidden">
          {photo?.imageUrl ? (
            <img 
              src={photo.imageUrl} 
              alt={room.name}
              className="w-full h-full object-cover"
              data-testid={`img-room-thumbnail-${room.id}`}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <CardHeader className="pb-2 pt-3">
            <div className="flex items-center gap-2">
              <DoorOpen className="h-5 w-5 text-muted-foreground flex-shrink-0" />
              <h3 className="font-semibold text-lg truncate" data-testid="text-room-name">{room.name}</h3>
            </div>
          </CardHeader>
          <CardContent className="space-y-1 pt-0 pb-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Building2 className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">{room.buildingAddress}</span>
            </div>
            {questionCount > 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ListChecks className="h-4 w-4 flex-shrink-0" />
                <span>{questionCount} required question{questionCount !== 1 ? 's' : ''}</span>
              </div>
            )}
          </CardContent>
        </div>
      </div>
    </Card>
  );
}
