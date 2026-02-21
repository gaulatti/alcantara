import React from 'react';
import './CronicaLayout.css';

interface CronicaReiteramosProps {
  text?: string;
  show?: boolean;
}

export const CronicaReiteramos: React.FC<CronicaReiteramosProps> = ({ text = 'REITERAMOS', show = true }) => {
  if (!show) return null;

  return (
    <div className='cronica-layer'>
      <div className='cronica-safe-area'>
        <div className='cronica-reiteramos'>{text}</div>
      </div>
    </div>
  );
};
