import React from 'react';
import './LogoWidget.css';

interface LogoWidgetProps {
  logoUrl?: string;
  text?: string;
  position?: 'top-right' | 'bottom-right';
}

export const LogoWidget: React.FC<LogoWidgetProps> = ({ logoUrl, text = 'mr', position = 'bottom-right' }) => {
  return (
    <div className={`logo-widget ${position}`}>
      {logoUrl ? <img src={logoUrl} alt='Logo' className='logo-image' /> : <div className='logo-text'>{text}</div>}
    </div>
  );
};
