import React from 'react';
import './CronicaLayout.css';

interface CronicaChyronProps {
  text?: string;
}

export const CronicaChyron: React.FC<CronicaChyronProps> = ({ text = '' }) => {
  if (!text) return null;

  return (
    <div className='cronica-layer'>
      <div className='cronica-safe-area'>
        <div className='cronica-chyron'>
          {text.split('\n').map((line, index) => (
            <div key={`cronica-line-${index}`} className='cronica-chyron-line'>
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
