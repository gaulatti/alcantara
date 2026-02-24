import React, { useEffect, useState } from 'react';
import './ToniLogo.css';

const LOGOS = ['/fifthbell.png', '/hn.png', '/mi.png'];
const INTERVAL_MS = 10000;

interface ToniLogoProps {
  callsign?: string;
  subtitle?: string;
}

export const ToniLogo: React.FC<ToniLogoProps> = ({ callsign = 'MR', subtitle }) => {
  const a11yLabel = subtitle ? `${callsign} ${subtitle}` : callsign;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % LOGOS.length);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className='toni-logo'>
      {LOGOS.map((src, i) => (
        <img key={src} src={src} alt={a11yLabel} className={`toni-logo-image${i === index ? ' toni-logo-image--active' : ''}`} />
      ))}
    </div>
  );
};
