import React from 'react';
import { Header } from './Header';
import { ClockWidget } from './ClockWidget';
import { QRCodeWidget } from './QRCodeWidget';
import { LiveIndicator } from './LiveIndicator';
import { Ticker } from './Ticker';
import { ChyronHolder } from './ChyronHolder';
import './BroadcastLayout.css';
import type { GlobalTimeOverride } from '../utils/broadcastTime';

interface BroadcastLayoutProps {
  children?: React.ReactNode;
  headerTitle?: string;
  headerDate?: string;
  hashtag?: string;
  url?: string;
  chyronText?: string;
  showChyron?: boolean;
  chyronDuration?: number;
  qrCodeUrl?: string;
  qrCodeContent?: string;
  clockIconUrl?: string;
  clockTimezone?: string;
  showLiveIndicator?: boolean;
  timeOverride?: GlobalTimeOverride | null;
}

export const BroadcastLayout: React.FC<BroadcastLayoutProps> = ({
  children,
  headerTitle,
  headerDate,
  hashtag,
  url,
  chyronText,
  showChyron = false,
  chyronDuration = 5000,
  qrCodeUrl,
  qrCodeContent,
  clockIconUrl,
  clockTimezone,
  showLiveIndicator = true,
  timeOverride = null
}) => {
  return (
    <div className='broadcast-layout'>
      {/* Top Header */}
      <Header title={headerTitle} date={headerDate} />

      {/* Clock Widget - Top Left */}
      <ClockWidget
        iconUrl={clockIconUrl}
        timezone={clockTimezone}
        timeOverride={timeOverride}
      />

      {/* QR Code - Middle Left */}
      <QRCodeWidget qrCodeUrl={qrCodeUrl} content={qrCodeContent} />

      {/* Live Indicator - Top Right */}
      {showLiveIndicator && <LiveIndicator />}

      {/* Main Content Area */}
      <div className='broadcast-content'>{children}</div>

      {/* Chyron - Above Ticker */}
      <ChyronHolder text={chyronText} show={showChyron} duration={chyronDuration} />

      {/* Ticker - Bottom */}
      <Ticker hashtag={hashtag} url={url} />
    </div>
  );
};
