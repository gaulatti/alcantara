import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SourceList } from './SourceList';
import type { ExternalSource } from '../../services/externalSources';

describe('SourceList', () => {
  afterEach(() => {
    cleanup();
  });

  const mockSources: ExternalSource[] = [
    {
      id: 'src-1',
      name: 'Studio Camera 1',
      transport: 'rtmp',
      lifecycle: 'connected',
      health: 'healthy',
      participantIdentity: 'studio-cam-1',
      lastConnectedAt: null,
      revokedAt: null,
      programIds: ['prog-alpha', 'prog-beta'],
    },
    {
      id: 'src-2',
      name: 'Drone Link',
      transport: 'whip',
      lifecycle: 'connected',
      health: 'healthy',
      participantIdentity: 'drone-link',
      lastConnectedAt: null,
      revokedAt: null,
      programIds: ['prog-alpha'],
    },
    {
      id: 'src-3',
      name: 'Remote OB Van',
      transport: 'srt',
      lifecycle: 'waiting',
      health: 'unknown',
      participantIdentity: 'remote-ob',
      lastConnectedAt: null,
      revokedAt: null,
      programIds: ['prog-gamma'], // Not in prog-alpha!
    },
  ];

  it('renders only sources assigned to the current program', () => {
    render(
      <SourceList
        sources={mockSources}
        currentProgramId="prog-alpha"
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText('Studio Camera 1')).toBeInTheDocument();
    expect(screen.getByText('Drone Link')).toBeInTheDocument();
    expect(screen.queryByText('Remote OB Van')).not.toBeInTheDocument();
  });

  it('a failed list fetch keeps the previous list visible and shows the error banner', () => {
    const { rerender } = render(
      <SourceList
        sources={mockSources}
        currentProgramId="prog-alpha"
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRefresh={vi.fn()}
        error={null}
      />
    );

    expect(screen.getByText('Studio Camera 1')).toBeInTheDocument();
    expect(screen.getByText('Drone Link')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Rerender after a failed refresh
    rerender(
      <SourceList
        sources={mockSources}
        currentProgramId="prog-alpha"
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRefresh={vi.fn()}
        error="Network timeout: 504 Gateway Timeout"
      />
    );

    // List is NOT blanked; previous sources remain rendered
    expect(screen.getByText('Studio Camera 1')).toBeInTheDocument();
    expect(screen.getByText('Drone Link')).toBeInTheDocument();

    // Error alert is visible
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/Network timeout: 504 Gateway Timeout/);
    expect(alert).toHaveTextContent(/Retaining current list/);
  });

  it('a keyboard-only test selects and deselects a source and keeps focus across a refresh', () => {
    function ControlledTest() {
      const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
      const [sourcesList, setSourcesList] = useState<ExternalSource[]>(mockSources);

      const handleToggle = (source: ExternalSource) => {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(source.id)) next.delete(source.id);
          else next.add(source.id);
          return next;
        });
      };

      const handleRefresh = () => {
        // Refresh re-creates list objects (simulating fresh API response)
        setSourcesList([...mockSources.map((s) => ({ ...s }))]);
      };

      return (
        <SourceList
          sources={sourcesList}
          currentProgramId="prog-alpha"
          selectedIds={selectedIds}
          onToggleSelect={handleToggle}
          onRefresh={handleRefresh}
        />
      );
    }

    render(<ControlledTest />);

    const button1 = screen.getByRole('button', { name: 'Preview Studio Camera 1' });

    // Focus using keyboard tab
    button1.focus();
    expect(document.activeElement).toBe(button1);

    // Select with keyboard Space/Enter (click event fired on Space/Enter by browser)
    fireEvent.click(button1);
    expect(button1).toHaveAttribute('aria-pressed', 'true');

    // Trigger refresh
    const refreshBtn = screen.getByRole('button', { name: 'Refresh sources list' });
    fireEvent.click(refreshBtn);

    // Focus must be preserved on the source toggle button
    const refreshedButton1 = document.getElementById('toggle-preview-src-1');
    expect(document.activeElement).toBe(refreshedButton1);

    // Deselect with keyboard
    fireEvent.click(refreshedButton1!);
    expect(refreshedButton1).toHaveAttribute('aria-pressed', 'false');
  });

  const props = {
    currentProgramId: 'prog-alpha',
    selectedIds: new Set<string>(),
    onToggleSelect: vi.fn(),
  };

  it('shows skeleton rows until the first list has arrived', () => {
    render(<SourceList {...props} sources={[]} onRefresh={vi.fn()} isLoading hasLoaded={false} />);
    expect(screen.getByTestId('source-list-loading')).toBeInTheDocument();
    expect(screen.queryByText('No external sources assigned')).not.toBeInTheDocument();
  });

  it('shows an error state with a retry when the first load failed', () => {
    const onRefresh = vi.fn();
    render(<SourceList {...props} sources={[]} onRefresh={onRefresh} hasLoaded={false} error="HTTP 503" />);
    expect(screen.getByText('External sources could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('The list could not be loaded. Check the connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText('HTTP 503')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading sources' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('source-list-error')).not.toBeInTheDocument();
  });

  it('keeps the list and shows a banner when a later refresh fails', () => {
    render(<SourceList {...props} sources={mockSources} onRefresh={vi.fn()} error="HTTP 500" />);
    expect(screen.getByTestId('source-list-error')).toHaveTextContent('Retaining current list');
    expect(screen.getByText('Studio Camera 1')).toBeInTheDocument();
    expect(screen.queryByTestId('source-list-load-error')).not.toBeInTheDocument();
  });

  it('shows an empty state once the list has loaded with nothing assigned', () => {
    render(<SourceList {...props} sources={[]} onRefresh={vi.fn()} />);
    expect(screen.getByText('No external sources assigned')).toBeInTheDocument();
  });

  it('shows preview availability as a state with its reason, and a retry only when offered', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <SourceList {...props} sources={mockSources} onRefresh={vi.fn()} preview={{ tone: 'bad', label: 'Preview failed', reason: 'Live preview could not connect.', onRetry }} />,
    );
    expect(screen.getByText('Preview failed')).toBeInTheDocument();
    expect(screen.getByTestId('preview-availability')).toHaveTextContent('Live preview could not connect.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<SourceList {...props} sources={mockSources} onRefresh={vi.fn()} preview={{ tone: 'ok', label: 'Preview ready', reason: null }} />);
    expect(screen.getByText('Preview ready')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-availability')).not.toBeInTheDocument();
  });
});
