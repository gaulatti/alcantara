import React from 'react';
import './ChyronHolder.css';

interface ChyronHolderProps {
  text?: string;
  show?: boolean;
}

export const ChyronHolder: React.FC<ChyronHolderProps> = ({ text = '', show = false }) => {
  const [visible, setVisible] = React.useState(show);
  const [displayText, setDisplayText] = React.useState(text);
  const [isChanging, setIsChanging] = React.useState(false);

  React.useEffect(() => {
    setVisible(show);
  }, [show]);

  React.useEffect(() => {
    if (text !== displayText) {
      setIsChanging(true);
      const timer = setTimeout(() => {
        setDisplayText(text);
        setIsChanging(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [text, displayText]);

  if (!visible || !text) {
    return null;
  }

  return (
    <div className={`chyron-holder ${visible ? 'chyron-visible' : ''}`}>
      <div className='chyron-content'>
        <div className={`chyron-text ${isChanging ? 'is-changing' : ''}`}>{displayText}</div>
      </div>
    </div>
  );
};
