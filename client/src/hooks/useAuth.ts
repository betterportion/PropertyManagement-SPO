import { useQuery } from "@tanstack/react-query";
import { isUnauthorizedError } from "@/lib/authUtils";

export function useAuth() {
  const { data: user, isLoading, error } = useQuery({
    queryKey: ["/api/auth/user"],
    retry: false,
    meta: {
      onError: (error: Error) => {
        if (isUnauthorizedError(error)) {
          return null;
        }
      },
    },
  });

  const isUnauthorized = error && isUnauthorizedError(error as Error);
  const isAuthenticated = !!user && !isUnauthorized;

  return {
    user: isUnauthorized ? null : user,
    isLoading: isLoading && !isUnauthorized,
    isAuthenticated,
  };
}
