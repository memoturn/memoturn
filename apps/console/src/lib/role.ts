import { useQuery } from "@tanstack/react-query";
import { api, getActiveProject } from "./api";

/**
 * Current workspace role for the active project. VIEWER is read-only (the server enforces
 * this via denyIfReadOnly / 403); the console mirrors it by disabling mutating controls.
 */
export function useActiveRole(): string | undefined {
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  if (!projects || projects.length === 0) return undefined;
  const active = getActiveProject() || projects[0]?.id || "";
  return projects.find((p) => p.id === active)?.role ?? projects[0]?.role;
}

/** True when the active project role is read-only (VIEWER). */
export function useIsReadOnly(): boolean {
  return (useActiveRole() ?? "").toUpperCase() === "VIEWER";
}
