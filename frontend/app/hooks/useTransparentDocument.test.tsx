import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTransparentDocument } from "./useTransparentDocument";

function Probe() {
  useTransparentDocument();
  return null;
}

describe("useTransparentDocument", () => {
  it("clears html and body backgrounds while mounted and restores them after", () => {
    document.documentElement.style.backgroundColor = "rgb(255, 255, 255)";
    const { unmount } = render(<Probe />);

    expect(document.documentElement.style.getPropertyValue("background-color")).toBe("transparent");
    expect(document.documentElement.style.getPropertyPriority("background-color")).toBe("important");
    expect(document.body.style.getPropertyValue("background-color")).toBe("transparent");

    unmount();
    expect(document.documentElement.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(document.body.style.backgroundColor).toBe("");
  });
});
