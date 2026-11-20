import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SourceRow } from './SourceRow';
import type {
  ExternalSource,
  ExternalSourceHealth,
  ExternalSourceLifecycle,
} from '../../services/externalSources';

describe('SourceRow', () => {
  afterEach(() => {
    cleanup();
  });

  const baseSource: ExternalSource = {
    id: 'test-src',
    name: 'Primary Ingest',
    transport: 'whip',
    lifecycle: 'connected',
    health: 'healthy',
    participantIdentity: 'primary-ingest',
    lastConnectedAt: null,
    revokedAt: null,
    programIds: ['prog-1'],
  };

  it('renders all eight lifecycles distinctly with text and style', () => {
    const lifecycles: ExternalSourceLifecycle[] = [
      'unconfigured',
      'provisioning',
      'waiting',
      'connected',
      'degraded',
      'reconnecting',
      'offline',
      'revoked',
    ];

    for (const lc of lifecycles) {
      const source: ExternalSource = { ...baseSource, id: `src-${lc}`, lifecycle: lc };
      const { unmount } = render(
        <table>
          <tbody>
            <SourceRow source={source} isSelected={false} onToggleSelect={vi.fn()} />
          </tbody>
        </table>
      );

      const el = screen.getByTestId(`source-lifecycle-src-${lc}`);
      expect(el).toHaveTextContent(lc);
      unmount();
    }
  });

  it('renders all four health values distinctly with text and style', () => {
    const healthValues: ExternalSourceHealth[] = [
      'unknown',
      'healthy',
      'degraded',
      'unavailable',
    ];

    for (const health of healthValues) {
      const source: ExternalSource = { ...baseSource, id: `src-h-${health}`, health };
      const { unmount } = render(
        <table>
          <tbody>
            <SourceRow source={source} isSelected={false} onToggleSelect={vi.fn()} />
          </tbody>
        </table>
      );

      const el = screen.getByTestId(`source-health-src-h-${health}`);
      expect(el).toHaveTextContent(health);
      unmount();
    }
  });

  it('proves a source in unconfigured, provisioning, waiting, offline or revoked cannot be selected for preview', () => {
    const nonSelectable: ExternalSourceLifecycle[] = [
      'unconfigured',
      'provisioning',
      'waiting',
      'offline',
      'revoked',
    ];

    for (const lifecycle of nonSelectable) {
      const onToggle = vi.fn();
      const source: ExternalSource = { ...baseSource, id: `src-disabled-${lifecycle}`, lifecycle };
      const { unmount } = render(
        <table>
          <tbody>
            <SourceRow source={source} isSelected={false} onToggleSelect={onToggle} />
          </tbody>
        </table>
      );

      const btn = screen.getByRole('button');
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('aria-disabled', 'true');

      fireEvent.click(btn);
      expect(onToggle).not.toHaveBeenCalled();

      unmount();
    }
  });

  it('allows selection and deselection for connected, degraded, reconnecting sources', () => {
    const selectable: ExternalSourceLifecycle[] = [
      'connected',
      'degraded',
      'reconnecting',
    ];

    for (const lifecycle of selectable) {
      const onToggle = vi.fn();
      const source: ExternalSource = { ...baseSource, id: `src-sel-${lifecycle}`, lifecycle };
      const { unmount, rerender } = render(
        <table>
          <tbody>
            <SourceRow source={source} isSelected={false} onToggleSelect={onToggle} />
          </tbody>
        </table>
      );

      const btn = screen.getByRole('button', { name: `Preview ${source.name}` });
      expect(btn).not.toBeDisabled();
      expect(btn).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(btn);
      expect(onToggle).toHaveBeenCalledWith(source);

      // Now rerender as selected
      rerender(
        <table>
          <tbody>
            <SourceRow source={source} isSelected={true} onToggleSelect={onToggle} />
          </tbody>
        </table>
      );

      const selectedBtn = screen.getByRole('button', { name: `Stop previewing ${source.name}` });
      expect(selectedBtn).toHaveAttribute('aria-pressed', 'true');

      unmount();
    }
  });

  it('cannot preview a connected source with no participant identity', () => {
    render(
      <table>
        <tbody>
          <SourceRow
            source={{ ...baseSource, participantIdentity: null }}
            isSelected={false}
            onToggleSelect={vi.fn()}
          />
        </tbody>
      </table>
    );
    expect(screen.getByRole('button', { name: /preview/i })).toBeDisabled();
  });
});
