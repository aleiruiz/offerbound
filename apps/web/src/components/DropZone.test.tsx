import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/render";
import { DropZone } from "./DropZone";

function zoneFor(disabled: boolean) {
  const onFile = vi.fn();
  renderWithProviders(
    <DropZone label="Test drop zone" onFile={onFile} disabled={disabled}>
      <button type="button" disabled={disabled}>
        Choose file
      </button>
    </DropZone>,
  );
  return { zone: screen.getByRole("group", { name: "Test drop zone" }), onFile };
}

describe("DropZone", () => {
  it("is dashed while it accepts files", () => {
    const { zone } = zoneFor(false);
    expect(zone).not.toHaveAttribute("data-disabled");
    expect(zone).toHaveStyle({ borderStyle: "dashed" });
  });

  it("looks muted and not dashed while disabled, and ignores drops", () => {
    const { zone, onFile } = zoneFor(true);
    expect(zone).toHaveAttribute("data-disabled", "true");
    expect(zone).toHaveStyle({ borderStyle: "solid" });
    expect(screen.queryByText("or drop a file here")).not.toBeInTheDocument();
    const file = new File(["x"], "cv.pdf", { type: "application/pdf" });
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(onFile).not.toHaveBeenCalled();
  });
});
