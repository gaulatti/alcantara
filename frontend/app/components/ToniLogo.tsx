import React from 'react';
import './ToniLogo.css';

interface ToniLogoProps {
  callsign?: string;
  subtitle?: string;
}

export const ToniLogo: React.FC<ToniLogoProps> = ({ callsign = 'MR', subtitle }) => {
  return (
    <div className='toni-logo'>
      <div className='toni-logo-accent' />
      <div className='toni-logo-body'>
        <div className='toni-logo-callsign'>{callsign}</div>
        {subtitle && <div className='toni-logo-subtitle'>{subtitle}</div>}
      </div>
    </div>
  );
};
