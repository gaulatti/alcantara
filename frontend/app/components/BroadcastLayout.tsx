import React from 'react';
import { BroadcastLayout as BleeckerBroadcastLayout, type BroadcastLayoutProps } from '../bleecker';
import { ClockWidget } from './ClockWidget';
import type { GlobalTimeOverride } from '../utils/broadcastTime';

interface AppBroadcastLayoutProps extends Omit<BroadcastLayoutProps, 'clock'> {
  /** Not used by the layout today; kept so stored scenes that carry it keep their shape. */
  chyronDuration?: number;
  clockIconUrl?: string;
  clockTimezone?: string;
  timeOverride?: GlobalTimeOverride | null;
}

/** The broadcast frame with this app's clock (which owns the broadcast time override) in its clock slot. */
export const BroadcastLayout: React.FC<AppBroadcastLayoutProps> = ({
  chyronDuration: _chyronDuration,
  clockIconUrl,
  clockTimezone,
  timeOverride = null,
  ...frame
}) => (
  <BleeckerBroadcastLayout
    {...frame}
    clock={<ClockWidget iconUrl={clockIconUrl} timezone={clockTimezone} timeOverride={timeOverride} />}
  />
);
