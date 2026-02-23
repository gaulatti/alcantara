import React from 'react';
import './ToniChyron.css';

interface ToniChyronProps {
  text?: string;
  show?: boolean;
  useMarquee?: boolean;
}

export const ToniChyron: React.FC<ToniChyronProps> = ({ text = '', show = false, useMarquee }) => {
  const [visible, setVisible] = React.useState(show);
  const [displayText, setDisplayText] = React.useState(text);
  const [isChanging, setIsChanging] = React.useState(false);
  const [needsMarquee, setNeedsMarquee] = React.useState(false);

  const textRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

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

  React.useEffect(() => {
    if (textRef.current && containerRef.current) {
      setNeedsMarquee(textRef.current.scrollWidth > containerRef.current.clientWidth);
    }
  }, [displayText]);

  if (!visible || !text) {
    return null;
  }

  const scrolling = useMarquee !== undefined ? useMarquee : needsMarquee;

  return (
    <div className={`toni-chyron ${visible ? 'toni-chyron-visible' : ''}`}>
      <div className='toni-chyron-accent' />
      <div ref={containerRef} className='toni-chyron-content'>
        <div
          ref={textRef}
          className={`toni-chyron-text ${isChanging ? 'is-changing' : ''} ${scrolling ? 'marquee' : ''}`}
        >
          {displayText}
        </div>
      </div>
    </div>
  );
};
