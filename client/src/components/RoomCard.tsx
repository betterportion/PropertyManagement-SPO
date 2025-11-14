import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Building2, DoorOpen, ListChecks } from "lucide-react";
import type { WalkthroughRoom } from "@shared/schema";

interface RoomCardProps {
  room: WalkthroughRoom;
  onClick: () => void;
}

export default function RoomCard({ room, onClick }: RoomCardProps) {
  const questionCount = room.requiredQuestions?.length || 0;

  return (
    <Card 
      className="hover-elevate active-elevate-2 cursor-pointer"
      onClick={onClick}
      data-testid={`card-room-${room.id}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <DoorOpen className="h-5 w-5 text-muted-foreground flex-shrink-0" />
          <h3 className="font-semibold text-lg truncate" data-testid="text-room-name">{room.name}</h3>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
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
    </Card>
  );
}
