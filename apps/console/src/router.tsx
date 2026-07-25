import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { RouteErrorComponent, RouteNotFoundComponent } from "./components/route-error";
import { routeTree } from "./routeTree.gen";

export function createRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    // Branded, actionable replacements for TanStack Router's bare defaults. The error
    // component special-cases stale-chunk (post-deploy) failures with a Reload primary action.
    defaultErrorComponent: RouteErrorComponent,
    defaultNotFoundComponent: RouteNotFoundComponent,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
