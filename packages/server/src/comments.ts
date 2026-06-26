import { prisma } from "@memoturn/db";

/** Comments on a trace / observation / session / prompt. */
export interface CreateCommentInput {
  objectType: string;
  objectId: string;
  content: string;
}

export async function createComment(projectId: string, author: string, input: CreateCommentInput) {
  const c = await prisma.comment.create({
    data: { projectId, author, objectType: input.objectType, objectId: input.objectId, content: input.content },
  });
  return {
    id: c.id,
    objectType: c.objectType,
    objectId: c.objectId,
    author: c.author,
    content: c.content,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listComments(projectId: string, objectType: string, objectId: string) {
  const rows = await prisma.comment.findMany({
    where: { projectId, objectType, objectId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((c) => ({
    id: c.id,
    objectType: c.objectType,
    objectId: c.objectId,
    author: c.author,
    content: c.content,
    createdAt: c.createdAt.toISOString(),
  }));
}

export async function deleteComment(projectId: string, id: string) {
  await prisma.comment.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}
