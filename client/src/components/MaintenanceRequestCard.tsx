import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Calendar, MapPin, User } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { MaintenanceRequest as MaintenanceRequestType, MaintenanceRequestPhoto } from "@shared/schema";
interface MaintenanceRequestCardProps { request: MaintenanceRequestType; onEdit?: () => void; isAdmin?: boolean; }
const priorityColors: Record<string, string> = { low: "bg-secondary text-secondary-foreground", medium: "bg-muted text-foreground", high: "bg-destructive text-destructive-foreground", urgent: "bg-destructive text-destructive-foreground", wishlist: "bg-accent text-accent-foreground" };
const statusColors: Record<string, string> = { pending: "bg-muted text-muted-foreground", in_progress: "bg-accent text-accent-foreground", completed: "bg-secondary text-secondary-foreground", cancelled: "bg-muted text-muted-foreground" };
export default function MaintenanceRequestCard({ request, onEdit, isAdmin = false }: MaintenanceRequestCardProps) {
 // One query for all request photos, deduped by React Query across every card on
 // the page; each card shows the photos for its own request (plus the legacy
 // single photoUrl, if a staff member set one).
 const { data: allPhotos = [] } = useQuery<MaintenanceRequestPhoto[]>({ queryKey: ["/api/maintenance-request-photos"] });
 const photoUrls = [
   ...(request.photoUrl ? [request.photoUrl] : []),
   ...allPhotos.filter((p) => p.requestId === request.id).map((p) => p.imageUrl),
 ];
 return <Card data-testid={`card-request-${request.id}`}><CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2"><div className="min-w-0"><h3 className="truncate font-semibold"><Link href={`/maintenance/${request.id}`} className="underline-offset-2 hover:underline" data-testid={`link-request-${request.id}`}>{request.title}</Link></h3><div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><MapPin className="h-3 w-3" />{request.location}</div></div><div className="flex shrink-0 flex-wrap justify-end gap-2"><Badge className={priorityColors[request.priority]}>{request.priority}</Badge><Badge className={statusColors[request.status]}>{request.status.replace("_"," ")}</Badge></div></CardHeader><CardContent><p className="mb-3 text-sm text-muted-foreground">{request.description}</p>{photoUrls.length > 0 && <div className="mb-3 grid grid-cols-3 gap-2" data-testid={`request-photos-${request.id}`}>{photoUrls.map((url) => <img key={url} src={url} alt="Maintenance request photo" className="h-24 w-full rounded-md border object-cover" />)}</div>}<div className="flex flex-wrap items-center justify-between gap-4 text-xs text-muted-foreground"><div className="flex flex-wrap gap-4"><span className="flex items-center gap-1"><User className="h-3 w-3" />{request.submittedBy}</span><span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{formatDate(request.submittedDate)}</span></div>{isAdmin && <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>}</div></CardContent></Card>;
}