import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";

// Helpers for the shared library list: the row menu and the delete confirmation.
// Rows menus run through inlineMenus (routeKit): each test file mocks Bleecker
// with it, because Bleecker's Radix popper runs continuously in jsdom.

const layer = (role: string) =>
  document.querySelector(`[role="${role}"]`) as HTMLElement | null;
const found = async (role: string) => {
  await waitFor(() => expect(layer(role)).not.toBeNull());
  return layer(role)!;
};

/** The visible primary action of a row, e.g. `rowAction("Play", "Station ID")`. */
export const rowAction = (label: string, name: string) =>
  screen.getByLabelText(`${label} ${name}`);

/** Opens a row's menu (Radix opens on Enter) and returns the menu. */
export async function openRowMenu(name: string) {
  const trigger = screen.getByLabelText(`More actions for ${name}`);
  fireEvent.keyDown(trigger, { key: "Enter" });
  return found("menu");
}

export async function chooseFromRowMenu(name: string, label: string) {
  const menu = await openRowMenu(name);
  const item = within(menu)
    .getAllByText(label)
    .map((element) => element.closest('[role="menuitem"]'))
    .find(Boolean) as HTMLElement;
  fireEvent.click(item);
}

/** The labels of a row's menu, in order. */
export async function rowMenuLabels(name: string) {
  const menu = await openRowMenu(name);
  const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
    (item) => item.textContent,
  );
  return labels;
}

export const confirmation = () => found("alertdialog");
const closed = () => waitFor(() => expect(layer("alertdialog")).toBeNull());
const dialogButton = async (label: string) =>
  within(await confirmation())
    .getAllByText(label)
    .map((element) => element.closest("button"))
    .find(Boolean) as HTMLButtonElement;
/** Presses the confirmation's button without expecting it to close (a delete that fails keeps it open). */
export const submitConfirmation = async (label: string) => {
  fireEvent.click(await dialogButton(label));
};
export const confirmWith = async (label: string) => {
  await submitConfirmation(label);
  await closed();
};
export const cancelConfirmation = async () => {
  fireEvent.click(await dialogButton("Cancel"));
  await closed();
};

/** The Bleecker mock every library route test installs. */
export const libraryBleecker = async (
  original: () => Promise<typeof import("@gaulatti/bleecker")>,
) => (await import("./routeKit")).inlineMenus(original);
