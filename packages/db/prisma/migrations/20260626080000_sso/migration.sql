-- Drop the (unused) oidc-provider tables and add the SSO plugin's ssoProvider table.
-- memoturn consumes external IdPs (OIDC/SAML) rather than acting as a provider.

DROP TABLE IF EXISTS "oauthConsent";
DROP TABLE IF EXISTS "oauthAccessToken";
DROP TABLE IF EXISTS "oauthApplication";

-- CreateTable
CREATE TABLE "ssoProvider" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "oidcConfig" TEXT,
    "samlConfig" TEXT,
    "userId" TEXT,
    "providerId" TEXT NOT NULL,
    "organizationId" TEXT,
    "domain" TEXT NOT NULL,

    CONSTRAINT "ssoProvider_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ssoProvider_providerId_key" ON "ssoProvider"("providerId");

-- AddForeignKey
ALTER TABLE "ssoProvider" ADD CONSTRAINT "ssoProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
