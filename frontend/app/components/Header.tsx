import React from 'react';
import './Header.css';

interface HeaderProps {
  title?: string;
  date?: string;
}

export const Header: React.FC<HeaderProps> = ({
  title = 'ModoSanremo',
  date = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
}) => {
  return (
    <div className='broadcast-header'>
      <div className='header-content'>
        <span className='header-text'>
          {title} | {date}
        </span>
      </div>
    </div>
  );
};
