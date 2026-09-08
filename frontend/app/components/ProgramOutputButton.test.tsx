import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgramOutputButton } from './ProgramOutputButton';

describe('ProgramOutputButton', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('disables output when no verified template is registered', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);

    render(<ProgramOutputButton outputUrl={null} />);

    const button = screen.getByRole('button', { name: 'Program output unavailable' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the verified external renderer in a new tab', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const outputUrl = 'https://cdn.fifthbell.com/html/program-releases/0.1.65/index.html';

    render(<ProgramOutputButton outputUrl={outputUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Program Output' }));

    expect(open).toHaveBeenCalledWith(outputUrl, '_blank', 'noopener,noreferrer');
  });
});
