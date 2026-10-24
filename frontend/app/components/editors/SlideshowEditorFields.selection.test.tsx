import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { SlideshowEditorFields } from './SlideshowEditorFields';
import type { MediaLabel } from '../../models/broadcast';

// Keep portal/focus browser fixtures isolated from asynchronous upload fixtures.
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const originalCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hasPointerCapture');
class BrowserPointerEvent extends MouseEvent {
  readonly pointerType: string;
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'mouse';
    this.pointerId = init.pointerId ?? 1;
  }
}
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
  vi.stubGlobal('PointerEvent', BrowserPointerEvent);
});
afterEach(() => cleanup());
afterAll(() => {
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  if (originalCapture) Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', originalCapture);
  else Reflect.deleteProperty(HTMLElement.prototype, 'hasPointerCapture');
  vi.unstubAllGlobals();
});

function selectOption(trigger: Element, label: string) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse', clientX: 10, clientY: 10 });
  const option = screen.getByText(label, { selector: '[role="option"] span' }).closest('[role="option"]')!;
  // Radix distinguishes opening the menu from selecting by pointer travel.
  fireEvent.pointerMove(option, { pointerType: 'mouse', clientX: 20, clientY: 100 });
  fireEvent.pointerDown(option, { pointerType: 'mouse', clientX: 20, clientY: 100 });
  fireEvent.pointerUp(option, { pointerType: 'mouse', clientX: 20, clientY: 100 });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
}

it('selects a canonical label and clears the legacy media-group reference', () => {
  const label: MediaLabel = { id: 'stills', name: 'Show stills', description: null, assetCount: 0, assets: [] };
  const updateProp = vi.fn();
  const { container } = render(<SlideshowEditorFields componentType="slideshow" props={{}} updateProp={updateProp} mediaLabels={[label]} isLoadingMediaLabels={false} />);
  fireEvent.change(screen.getByPlaceholderText('Search labels…'), { target: { value: 'show' } });
  selectOption(container.querySelectorAll('[role="combobox"]')[1], 'Show stills (0 images)');
  expect(updateProp).toHaveBeenCalledWith('slideshow', 'labelId', 'stills');
  expect(updateProp).toHaveBeenCalledWith('slideshow', 'mediaGroupId', null);
});

it('persists fit-mode selection through the actual select control', () => {
  const updateProp = vi.fn();
  const { container } = render(<SlideshowEditorFields componentType="slideshow" props={{ fitMode: 'contain' }} updateProp={updateProp} mediaLabels={[]} isLoadingMediaLabels={false} />);
  selectOption(container.querySelectorAll('[role="combobox"]')[0], 'Cover');
  expect(updateProp).toHaveBeenCalledWith('slideshow', 'fitMode', 'cover');
});
