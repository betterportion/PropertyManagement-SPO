import { LogOut, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface UserMenuProps {
  user: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  } | null;
}

export default function UserMenu({ user }: UserMenuProps) {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const label = name || user?.email || "Your account";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu" data-testid="button-user-menu">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
            <UserIcon className="h-4 w-4 text-primary-strong" />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-medium">
          <span className="block truncate">{label}</span>
          {name && user?.email && (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {user.email}
            </span>
          )}
        </DropdownMenuLabel>
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
