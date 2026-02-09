import React from 'react';
import './LiveIndicator.css';

interface LiveIndicatorProps {
  text?: string;
  animate?: boolean;
}

export const LiveIndicator: React.FC<LiveIndicatorProps> = ({ text = 'VIVO', animate = true }) => {
  return (
    <div className='live-indicator'>
      <div className={`live-badge ${animate ? 'animate' : ''}`}></div>
    </div>
  );
};
