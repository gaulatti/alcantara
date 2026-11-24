import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CatalogFilter } from "./CatalogFilter";

// gaulatti/alcantara#527 (catalog filter, untriaged gaps): a choice shows its count only when it has one.

afterEach(cleanup);

it("shows a count on a choice that has one, and none on a choice that has not", () => {
  const onChange = vi.fn();
  render(
    <CatalogFilter
      label="Catalog state"
      value="all"
      onChange={onChange}
      options={[
        { value: "all", label: "All", count: 12 },
        { value: "enabled", label: "Enabled" },
      ]}
    />,
  );
  const group = screen.getByRole("group", { name: "Catalog state" });
  expect(within(group).getByRole("button", { name: /All/ })).toHaveTextContent("12");
  const enabled = within(group).getByRole("button", { name: "Enabled" });
  expect(enabled).toHaveTextContent(/^Enabled$/);
  fireEvent.click(enabled);
  expect(onChange).toHaveBeenCalledWith("enabled");
});
