import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "./components/theme-provider";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { analyticsEnabled, initAnalytics, trackPageView } from "./lib/analytics";
import { createRouter } from "./router";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});

const router = createRouter();

// Public-demo builds only (VITE_GA_MEASUREMENT_ID) — no-op everywhere else.
initAnalytics();
if (analyticsEnabled) {
  // onResolved fires on the initial load and after every navigation, so this is the
  // single page_view source (auto page_view is disabled in initAnalytics).
  router.subscribe("onResolved", () => trackPageView());
}

const rootElement = document.getElementById("app")!;
if (!rootElement.innerHTML) {
  ReactDOM.createRoot(rootElement).render(
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}
