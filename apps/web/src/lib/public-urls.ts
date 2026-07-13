/**
 * Public URLs the marketing site links out to. Defaults to production
 * hostnames; override per environment via Vite mode-loaded dotenv files.
 */

function resolve(envValue: string | undefined, fallback: string): string {
  const raw = envValue?.trim() || fallback;
  return raw.replace(/\/$/, "");
}

export const DOCS_PUBLIC_URL = resolve(
  import.meta.env.VITE_PUBLIC_DOCS_URL as string | undefined,
  "https://docs.memoturn.ai",
);

export const GITHUB_URL = "https://github.com/memoturn/memoturn";
