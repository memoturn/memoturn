import type { McpConnection } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";

/**
 * The signed-in user's OAuth 2.1 client connections (remote MCP IDEs/agents) — one per
 * consent the user has granted, joined with the client's public registration metadata.
 */
export async function listMcpConnections(userId: string): Promise<McpConnection[]> {
  const consents = await prisma.oauthConsent.findMany({
    where: { userId },
    include: { client: { select: { clientId: true, name: true, uri: true } } },
    orderBy: { createdAt: "desc" },
  });
  return consents.map((c) => ({
    consentId: c.id,
    clientId: c.clientId,
    clientName: c.client?.name ?? null,
    clientUri: c.client?.uri ?? null,
    scopes: c.scopes,
    createdAt: c.createdAt?.toISOString() ?? null,
  }));
}

/**
 * Disconnect an OAuth client for a user: delete the consent (blocks future authorize
 * flows for those scopes) AND revoke the grant — mark the user's refresh tokens for that
 * client revoked (the plugin's rotation check then rejects the whole family) and drop any
 * stored opaque access tokens. Deleting the consent alone is NOT enough: the refresh
 * grant never re-checks consent, so an un-revoked refresh token would keep working for
 * up to 30 days. Already-issued JWT access tokens can't be recalled — they expire within
 * the hour. Returns false when the consent doesn't exist or belongs to another user.
 */
export async function disconnectMcpClient(
  userId: string,
  consentId: string,
): Promise<{ deleted: boolean; clientId?: string }> {
  const consent = await prisma.oauthConsent.findUnique({ where: { id: consentId } });
  if (!consent || consent.userId !== userId) return { deleted: false };
  await prisma.$transaction([
    prisma.oauthConsent.delete({ where: { id: consentId } }),
    prisma.oauthRefreshToken.updateMany({
      where: { userId, clientId: consent.clientId, revoked: null },
      data: { revoked: new Date() },
    }),
    prisma.oauthAccessToken.deleteMany({ where: { userId, clientId: consent.clientId } }),
  ]);
  return { deleted: true, clientId: consent.clientId };
}
