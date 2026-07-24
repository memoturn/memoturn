// Delegated click-to-copy for any element carrying `data-command`. A single
// listener on `document` (bound once) keeps copy working for elements that
// mount after first paint and across Astro/Starlight view transitions — the
// exact failure mode a per-element, run-once handler hits, where the second
// visit to a page leaves the button wired to nothing.
let bound = false;

export function initCopyToClipboard(): void {
  if (bound || typeof document === "undefined") return;
  bound = true;

  document.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement | null;
    const trigger = target?.closest<HTMLElement>("[data-command]");
    if (!trigger) return;

    const command = trigger.dataset.command ?? "";
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return; // clipboard unavailable (insecure context, denied) — text stays selectable
    }

    const status = trigger.querySelector<HTMLElement>("[data-copy-status]");
    const restoreLabel = trigger.getAttribute("aria-label");

    trigger.classList.add("is-copied");
    trigger.setAttribute("aria-label", "Copied");
    if (status) status.textContent = "Command copied to clipboard";

    window.clearTimeout(Number(trigger.dataset.copyTimer));
    trigger.dataset.copyTimer = String(
      window.setTimeout(() => {
        trigger.classList.remove("is-copied");
        if (restoreLabel) trigger.setAttribute("aria-label", restoreLabel);
        if (status) status.textContent = "";
      }, 2000),
    );
  });
}
