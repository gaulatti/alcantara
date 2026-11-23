import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProgramChyronEditorFields } from "./ProgramChyronEditorFields";

// gaulatti/alcantara#186: the chyron fields seed a legacy text or CTA into the
// sequence editor when the stored sequence has no text of its own.

afterEach(() => {
  cleanup();
});

function renderFields(props: Record<string, unknown>) {
  return render(
    <ProgramChyronEditorFields
      componentType="chyron"
      props={props}
      updateProp={vi.fn()}
      replaceProps={vi.fn()}
    />,
  );
}

it("shows a legacy chyron text when the first stored item is a nested sequence without text", () => {
  renderFields({
    text: "Legacy headline",
    textSequence: {
      mode: "manual",
      items: [
        {
          id: "nested",
          kind: "sequence",
          label: "Empty block",
          sequence: { mode: "manual", items: [], activeItemId: null },
        },
      ],
      activeItemId: "nested",
    },
  });
  expect(screen.getByDisplayValue("Legacy headline")).toBeTruthy();
});

it("shows a legacy chyron text when the stored sequence has no items", () => {
  renderFields({
    text: "Legacy headline",
    textSequence: { mode: "manual", items: [], activeItemId: null },
  });
  expect(screen.getByDisplayValue("Legacy headline")).toBeTruthy();
});

it("shows a legacy CTA when the stored CTA sequence is a nested sequence without text", () => {
  renderFields({
    cta: "Legacy call to action",
    ctaSequence: {
      mode: "manual",
      items: [
        {
          id: "nested-cta",
          kind: "sequence",
          label: "Empty block",
          sequence: { mode: "manual", items: [], activeItemId: null },
        },
      ],
      activeItemId: "nested-cta",
    },
  });
  expect(screen.getByDisplayValue("Legacy call to action")).toBeTruthy();
});

it("shows a legacy CTA when the stored CTA sequence has no items", () => {
  renderFields({
    cta: "Legacy call to action",
    ctaSequence: { mode: "manual", items: [], activeItemId: null },
  });
  expect(screen.getByDisplayValue("Legacy call to action")).toBeTruthy();
});
