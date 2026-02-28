import React from 'react';
import './Earone.css';

interface EaroneProps {
  rank?: string | number | null;
  spins?: string | number | null;
  label?: string;
}

function formatMetric(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString('en-US');
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return '';
  }

  if (/^\d+$/.test(normalized)) {
    return Number(normalized).toLocaleString('en-US');
  }

  return normalized;
}

export const Earone: React.FC<EaroneProps> = ({
  rank = '',
  spins = '',
  label = 'EARONE'
}) => {
  const rankText = formatMetric(rank);
  const spinsText = formatMetric(spins);
  const [displayRank, setDisplayRank] = React.useState(rankText);
  const [displaySpins, setDisplaySpins] = React.useState(spinsText);
  const [isTransitioning, setIsTransitioning] = React.useState(false);

  React.useEffect(() => {
    if (rankText === displayRank && spinsText === displaySpins) {
      return;
    }

    setIsTransitioning(true);
    const timer = window.setTimeout(() => {
      setDisplayRank(rankText);
      setDisplaySpins(spinsText);
      setIsTransitioning(false);
    }, 180);

    return () => window.clearTimeout(timer);
  }, [rankText, spinsText, displayRank, displaySpins]);

  if (!rankText && !spinsText && !displayRank && !displaySpins) {
    return null;
  }

  return (
    <div className='earone-box'>
      <div className='earone-brand'>
        <img src='/earone.svg' alt={label} className='earone-brand-image' />
      </div>
      <div className='earone-live-badge'>EN TIEMPO REAL</div>
      <div className={`earone-metric${isTransitioning ? ' earone-metric--transitioning' : ''}`}>
        <span className='earone-metric-label'>RANKING</span>
        <span className='earone-metric-value'>{displayRank ? `#${displayRank}` : '--'}</span>
      </div>
      <div className='earone-divider' aria-hidden='true' />
      <div className={`earone-metric${isTransitioning ? ' earone-metric--transitioning' : ''}`}>
        <span className='earone-metric-label'>REPRODUCCIONES EN RADIO HOY</span>
        <span className='earone-metric-value'>{displaySpins || '--'}</span>
      </div>
    </div>
  );
};
