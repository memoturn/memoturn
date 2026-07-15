import { passkeyClient } from "@better-auth/passkey/client";
import { ssoClient } from "@better-auth/sso/client";
import {
  adminClient,
  emailOTPClient,
  magicLinkClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth browser client. Requests go to `/api/auth/*`, which the Vite dev proxy
 * forwards to the API's `/auth/*` (cookies flow through). baseURL defaults to the
 * current origin in the browser. The organization plugin exposes authClient.organization.*
 * (create / list / setActive / inviteMember / …).
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [
    organizationClient(),
    ssoClient(),
    magicLinkClient(),
    emailOTPClient(),
    twoFactorClient(),
    passkeyClient(),
    adminClient(),
  ],
});

export const { signIn, signOut, useSession } = authClient;
