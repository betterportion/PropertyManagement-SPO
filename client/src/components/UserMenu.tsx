import { LogOut, User as UserIcon } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface UserMenuProps {
  user: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    commentEmailsEnabled?: boolean | null;
  } | null;
}

export default function UserMenu({ user }: UserMenuProps) {
  const { toast } = useToast();
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const label = name || user?.email || "Your account";

  // The comment email off switch, for oneself. The server is the record of
  // what it is set to, so the account query is refetched rather than the
  // checkbox trusting its own state.
  const commentEmails = useMutation({
    mutationFn: async (enabled: boolean) => {
      await apiRequest("PATCH", "/api/auth/me/notifications", { commentEmailsEnabled: enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
    },
    onError: () => {
      toast({
        title: "That did not save",
        description: "Your email setting was not changed. Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu" data-testid="button-user-menu">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
            <UserIcon className="h-4 w-4 text-primary-strong" />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-medium">
          <span className="block truncate">{label}</span>
          {name && user?.email && (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {user.email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={user?.commentEmailsEnabled !== false}
          onCheckedChange={(checked) => commentEmails.mutate(checked === true)}
          // Stays open so the tick is seen to change.
          onSelect={(event) => event.preventDefault()}
          disabled={commentEmails.isPending}
          data-testid="checkbox-comment-emails"
        >
          Email me when somebody comments on a request
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            window.location.href = "/api/logout";
          }}
          data-testid="button-logout"
        >
          <LogOut className="h-4 w-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
