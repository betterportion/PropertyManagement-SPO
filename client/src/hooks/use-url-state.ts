import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";

/**
 * Keeps filter / search / tab state in the URL so a view can be bookmarked,
 * shared, and restored on refresh — §6 of the SPO design system.
 *
 *   const [filters, setFilters] = useUrlState({ status: "all", q: "" });
 *   setFilters({ status: "open" });
 *
 * Values equal to their default are dropped from the URL so links stay short.
 * Any query parameter not named in `defaults` is left untouched.
 */
export function useUrlState<T extends Record<string, string>>(
  defaults: T,
): [T, (patch: Partial<T>) => void, () => void] {
  const search = useSearch();
  const [location, navigate] = useLocation();

  // `defaults` is usually an inline object literal, so key off its contents
  // rather than its identity to avoid re-running on every render.
  const defaultsKey = JSON.stringify(defaults);

  const values = useMemo(() => {
    const params = new URLSearchParams(search);
    const parsed = { ...defaults } as T;
    for (const key of Object.keys(defaults) as Array<keyof T & string>) {
      const raw = params.get(key);
      if (raw !== null) parsed[key] = raw as T[keyof T & string];
    }
    return parsed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, defaultsKey]);

  const write = useCallback(
    (params: URLSearchParams) => {
      const query = params.toString();
      // `location` from wouter excludes the query string.
      navigate(query ? `${location}?${query}` : location, { replace: true });
    },
    [location, navigate],
  );

  const setValues = useCallback(
    (patch: Partial<T>) => {
      const params = new URLSearchParams(search);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value === "" || value === defaults[key as keyof T]) {
          params.delete(key);
        } else {
          params.set(key, String(value));
        }
      }
      write(params);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, defaultsKey, write],
  );

  const reset = useCallback(() => {
    const params = new URLSearchParams(search);
    for (const key of Object.keys(defaults)) params.delete(key);
    write(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, defaultsKey, write]);

  return [values, setValues, reset];
}
