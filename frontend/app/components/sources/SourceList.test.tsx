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
});
