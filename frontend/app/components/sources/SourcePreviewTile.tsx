import React, { useEffect, useRef } from 'react';
import { Card, Button, StatusBadge } from '@gaulatti/bleecker';
import { AlertCircle, X, VideoOff } from 'lucide-react';
import { useSourceSubscription } from './SourcesSubscriptionContext';
import { AudioMeter } from './AudioMeter';
import type { ExternalSource } from '../../services/externalSources';

export interface SourcePreviewTileProps {
  source: ExternalSource;
  onDeselect: () => void;
  className?: string;
}

export function SourcePreviewTile({
  source,
  onDeselect,
  className = '',
}: SourcePreviewTileProps) {
  const { videoTrack, audioTrack, audioLevel, error } = useSourceSubscription(
    source.participantIdentity
  );
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !videoTrack) return;

    if (typeof videoTrack.attach === 'function') {
      videoTrack.attach(el);
    }

    return () => {
      if (typeof videoTrack.detach === 'function') {
        videoTrack.detach(el);
      }
    };
  }, [videoTrack]);

  return (
    <Card
      className={`relative flex flex-col overflow-hidden border border-zinc-800 bg-zinc-950 p-0 shadow-lg ${className}`}
      data-testid={`preview-tile-${source.id}`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/60 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-xs text-zinc-100 truncate" title={source.name}>
            {source.name}
          </span>
          <span className="text-[10px] font-mono uppercase text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">
            {source.transport}
          </span>
          <StatusBadge
            label={source.lifecycle}
            variant={
              source.lifecycle === 'connected'
                ? 'live'
                : source.lifecycle === 'degraded' || source.lifecycle === 'reconnecting'
                ? 'offline'
                : 'default'
            }
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDeselect}
          aria-label={`Deselect ${source.name}`}
          className="h-6 w-6 p-0 text-zinc-400 hover:text-zinc-100"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Video Viewport */}
      <div className="relative aspect-video w-full bg-black flex items-center justify-center overflow-hidden">
        {videoTrack ? (
          <video
            ref={videoRef}
            data-testid={`video-preview-${source.id}`}
            autoPlay
            playsInline
            muted
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-1 text-zinc-500">
            <VideoOff className="h-8 w-8 stroke-[1.5]" />
            <span className="text-xs">No video stream</span>
          </div>
        )}

        {/* Isolated Error Overlay */}
        {error && (
          <div
            data-testid={`tile-error-${source.id}`}
            className="absolute inset-x-2 top-2 rounded bg-rose-950/90 border border-rose-700/60 p-2 text-rose-200 flex items-start gap-2 text-xs shadow-md backdrop-blur-xs"
          >
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
            <span className="leading-tight">{error}</span>
          </div>
        )}
      </div>

      {/* Footer controls: Audio Meter & Metadata */}
      <div className="flex items-center justify-between border-t border-zinc-800/80 bg-zinc-900/40 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-400">Audio:</span>
          <AudioMeter
            level={audioLevel}
            audioTrack={audioTrack}
            label={`Audio meter for ${source.name}`}
          />
        </div>
        <div className="text-[10px] text-zinc-500 font-mono">
          Health: <span className="text-zinc-400 capitalize">{source.health}</span>
        </div>
      </div>
    </Card>
  );
}
