import React, { useEffect, useState } from 'react';
import './ToniLogo.css';

export const DEFAULT_TONI_LOGOS = ['/fifthbell/images/fifthbell.png', '/hn.png', '/mi.png'];
const DEFAULT_INTERVAL_MS = 10000;

interface ToniLogoProps {
  callsign?: string;
  subtitle?: string;
  logos?: string[];
  rotationIntervalMs?: number;
  rotate?: boolean;
  initialIndex?: number;
}

export const ToniLogo: React.FC<ToniLogoProps> = ({
  callsign = 'MR',
  subtitle,
  logos = DEFAULT_TONI_LOGOS,
  rotationIntervalMs = DEFAULT_INTERVAL_MS,
  rotate = true,
  initialIndex = 0
}) => {
  const a11yLabel = subtitle ? `${callsign} ${subtitle}` : callsign;
  const resolvedLogos = logos.length > 0 ? logos : DEFAULT_TONI_LOGOS;
  const normalizedInitialIndex = ((initialIndex % resolvedLogos.length) + resolvedLogos.length) % resolvedLogos.length;
  const [index, setIndex] = useState(normalizedInitialIndex);

  useEffect(() => {
    setIndex(normalizedInitialIndex);
  }, [normalizedInitialIndex]);

  useEffect(() => {
    if (!rotate || resolvedLogos.length <= 1) {
      return;
    }

    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % resolvedLogos.length);
    }, rotationIntervalMs);
    return () => clearInterval(timer);
  }, [resolvedLogos, rotate, rotationIntervalMs]);

  return (
    <div className='toni-logo'>
      {resolvedLogos.map((src, i) => (
        <img key={src} src={src} alt={a11yLabel} className={`toni-logo-image${i === index ? ' toni-logo-image--active' : ''}`} />
      ))}
    </div>
  );
};
