import React from 'react';
import './Ticker.css';

interface TickerProps {
  hashtag?: string;
  url?: string;
}

export const Ticker: React.FC<TickerProps> = ({ hashtag = '#ModoitalianoMR', url = 'modoradio.cl' }) => {
  return (
    <div className='ticker'>
      <div className='ticker-content'>
        <span className='ticker-hashtag'>{hashtag}</span>
        <span className='ticker-url'>{url}</span>
      </div>
    </div>
  );
};
