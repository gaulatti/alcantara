import React from 'react';
import './LiveIndicator.css';

interface LiveIndicatorProps {
  animate?: boolean;
}

export const LiveIndicator: React.FC<LiveIndicatorProps> = ({ animate = true }) => {
  return (
    <div className='live-indicator'>
      <div className={`live-badge ${animate ? 'animate' : ''}`}></div>
    </div>
  );
};
