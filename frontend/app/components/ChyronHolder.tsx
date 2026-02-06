import React from 'react';
import './ChyronHolder.css';

interface ChyronHolderProps {
  text?: string;
  show?: boolean;
}

export const ChyronHolder: React.FC<ChyronHolderProps> = ({ text = '', show = false }) => {
  const [visible, setVisible] = React.useState(show);

  React.useEffect(() => {
    setVisible(show);
  }, [show]);

  if (!visible || !text) {
    return null;
  }

  return (
    <div className={`chyron-holder ${visible ? 'chyron-visible' : ''}`}>
      <div className='chyron-content'>
        <div className='chyron-text'>{text}</div>
      </div>
    </div>
  );
};
