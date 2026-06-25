import { createAuthClient } from "better-auth/react";

/**
 * Better Auth browser client. Requests go to `/api/auth/*`, which the Vite dev proxy
 * forwards to the API's `/auth/*` (cookies flow through). baseURL defaults to the
 * current origin in the browser.
 */
export const authClient = createAuthClient({ basePath: "/api/auth" });

export const { signIn, signOut, useSession } = authClient;
