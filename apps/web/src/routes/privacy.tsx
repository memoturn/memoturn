import { Button } from "@memoturn/ui";
import { createFileRoute } from "@tanstack/react-router";
import { resetConsent } from "../lib/analytics";
import { GITHUB_URL } from "../lib/public-urls";

const TITLE = "Privacy — Memoturn";
const DESCRIPTION =
  "What the Memoturn public sites and hosted demo collect, why, and how to opt out. Self-hosted Memoturn sends us nothing.";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
    links: [{ rel: "canonical", href: "https://memoturn.com/privacy" }],
  }),
  component: PrivacyPage,
});

const H2_CLASS = "display-title mt-10 mb-3 text-xl font-bold tracking-tight text-foreground";
const P_CLASS = "mb-4 text-pretty text-[15px] leading-relaxed text-muted-foreground";
const LINK_CLASS = "text-foreground underline underline-offset-2 hover:no-underline";

function PrivacyPage() {
  return (
    <div className="page-wrap py-16 sm:py-24">
      <article className="mx-auto max-w-2xl">
        <p className="mb-3 font-mono text-xs tracking-[0.04em] text-muted-foreground">privacy</p>
        <h1 className="display-title mb-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Privacy, in plain terms.
        </h1>
        <p className={P_CLASS}>
          This page covers the Memoturn public web properties: <strong className="text-foreground">memoturn.com</strong>
          , <strong className="text-foreground">docs.memoturn.com</strong>, and the hosted demo at{" "}
          <strong className="text-foreground">demo.memoturn.com</strong>. It does not cover Memoturn installations you
          run yourself — a self-hosted Memoturn sends nothing to us, and its builds contain no analytics code at all.
        </p>

        <h2 className={H2_CLASS}>Analytics</h2>
        <p className={P_CLASS}>
          We use Google Analytics 4 to understand which pages matter and where visitors come from: pages viewed,
          referring site, approximate location (city level), and browser/device type. We run no ads, do no ad tracking,
          and never sell or share visitor data. In the EEA, the UK, and Switzerland, analytics cookies stay off until
          you accept the consent banner; declining (anywhere) turns them off. On the demo, page URLs are stripped of
          query strings before they are sent, so sign-in tokens never reach analytics.
        </p>
        <p className={P_CLASS}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              resetConsent();
              window.location.reload();
            }}
          >
            Reset cookie choice
          </Button>
        </p>

        <h2 className={H2_CLASS}>The hosted demo</h2>
        <p className={P_CLASS}>
          Signing into the demo takes an email address, used only to send you the one-time sign-in link and to keep your
          sandbox yours while it exists. No marketing email, ever. Sandboxes (including the account row and everything
          in them) are deleted automatically about a week after creation. The telemetry in a sandbox is generated sample
          data — please don't paste real secrets or personal data into it.
        </p>

        <h2 className={H2_CLASS}>Service providers</h2>
        <p className={P_CLASS}>
          The public sites are served by Cloudflare; the demo runs on Google Cloud; demo sign-in emails are delivered by
          a transactional email provider; analytics is processed by Google. Each receives only what's needed to do its
          job.
        </p>

        <h2 className={H2_CLASS}>Questions</h2>
        <p className={P_CLASS}>
          Memoturn is open source — the analytics implementation described here is{" "}
          <a href={GITHUB_URL} target="_blank" rel="noopener" className={LINK_CLASS}>
            readable in the repository
          </a>
          . For privacy questions or deletion requests (demo sandboxes delete themselves, but we're happy to do it
          sooner),{" "}
          <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener" className={LINK_CLASS}>
            open an issue
          </a>
          .
        </p>
      </article>
    </div>
  );
}
