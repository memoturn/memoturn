import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./button";

describe("Button", () => {
  it("renders an accessible button with its label", () => {
    render(<Button>Create agent</Button>);

    const button = screen.getByRole("button", { name: "Create agent" });
    expect(button.dataset.slot).toBe("button");
    expect(button.dataset.variant).toBe("default");
  });

  it("exposes variant and size through data attributes", () => {
    render(
      <Button variant="destructive" size="sm">
        Delete agent
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Delete agent" });
    expect(button.dataset.variant).toBe("destructive");
    expect(button.dataset.size).toBe("sm");
  });
});
