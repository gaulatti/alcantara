import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SourcePreviewTile } from './SourcePreviewTile';
import { SourcesSubscriptionContext } from './SourcesSubscriptionContext';
import type { ExternalSource } from '../../services/externalSources';

describe('SourcePreviewTile', () => {
  afterEach(() => {
    cleanup();
  });

  const mockSource: ExternalSource & { participantIdentity: string } = {
    id: 'src-123',
    name: 'Camera Studio A',
    transport: 'rtmp',
    lifecycle: 'connected',
    health: 'healthy',
    participantIdentity: 'camera-studio-a',
    lastConnectedAt: '2026-11-14T10:00:00Z',
    revokedAt: null,
    programIds: ['main'],
  };

  function renderWithSubscription(
    ui: React.ReactElement,
    subscriptionState: Partial<{
      videoTrack: any;
      audioTrack: any;
      audioLevel: number;
      error: string | null;
      isSubscribed: boolean;
    }> = {}
  ) {
    const fullState = {
      participantIdentity: mockSource.participantIdentity,
      videoTrack: null,
      audioTrack: null,
      audioLevel: 0,
      error: null,
      isSubscribed: true,
      ...subscriptionState,
    };

    const mockContext = {
      room: null,
      subscribeSource: vi.fn(() => vi.fn()),
      useSourceSubscription: vi.fn(() => fullState),
      getSourceState: vi.fn(() => fullState),
    };

    return render(
      <SourcesSubscriptionContext.Provider value={mockContext}>
        {ui}
      </SourcesSubscriptionContext.Provider>
    );
  }

  it('renders source metadata, audio meter and handles deselect', () => {
    const onDeselect = vi.fn();
    renderWithSubscription(
      <SourcePreviewTile source={mockSource} onDeselect={onDeselect} />,
      { audioLevel: 45 }
    );

    expect(screen.getByText('Camera Studio A')).toBeInTheDocument();
    expect(screen.getByText('rtmp')).toBeInTheDocument();
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Audio meter for Camera Studio A' })).toBeInTheDocument();

    const deselectBtn = screen.getByRole('button', { name: 'Deselect Camera Studio A' });
    fireEvent.click(deselectBtn);
    expect(onDeselect).toHaveBeenCalledTimes(1);
  });

  it('attaches video track when present', () => {
    const attach = vi.fn();
    const detach = vi.fn();
    const mockVideoTrack = {
      kind: 'video',
      attach,
      detach,
    };

    const { unmount } = renderWithSubscription(
      <SourcePreviewTile source={mockSource} onDeselect={vi.fn()} />,
      { videoTrack: mockVideoTrack }
    );

    const video = screen.getByTestId('video-preview-src-123');
    expect(video).toBeInTheDocument();
    expect(attach).toHaveBeenCalledWith(video);

    unmount();
    expect(detach).toHaveBeenCalledWith(video);
  });

  it('displays isolated error overlay when subscription reports an error', () => {
    renderWithSubscription(
      <SourcePreviewTile source={mockSource} onDeselect={vi.fn()} />,
      { error: 'Connection dropped unexpectedly' }
    );

    const errorEl = screen.getByTestId('tile-error-src-123');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl).toHaveTextContent('Connection dropped unexpectedly');
  });

  it('contains no controls that change Program', () => {
    renderWithSubscription(
      <SourcePreviewTile source={mockSource} onDeselect={vi.fn()} />
    );

    expect(screen.queryByText(/cut/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/take/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stage/i)).not.toBeInTheDocument();
  });
});
