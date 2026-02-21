import React from 'react';
import { LogoWidget } from './LogoWidget';
import { ClockWidget } from './ClockWidget';
import './CronicaLayout.css';

interface CronicaLayoutProps {
  headline?: string;
  reiteramosText?: string;
  showReiteramos?: boolean;
  timezone?: string;
}

export const CronicaLayout: React.FC<CronicaLayoutProps> = ({
  headline = 'VOLVIO AHORA 12!\nDESPIDOS EN\n12 CUOTAS',
  reiteramosText = 'REITERAMOS',
  showReiteramos = true,
  timezone
}) => {
  return (
    <div className='cronica-layout'>
      <div className='cronica-safe-area'>
        {showReiteramos && <div className='cronica-reiteramos'>{reiteramosText}</div>}

        <div className='cronica-chyron'>
          {headline.split('\n').map((line, index) => (
            <div key={`cronica-line-${index}`} className='cronica-chyron-line'>
              {line}
            </div>
          ))}
        </div>
      </div>
      <LogoWidget />
      <ClockWidget timezone={timezone} />
    </div>
  );
};
