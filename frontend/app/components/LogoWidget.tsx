import React, { useState, useEffect } from 'react';
import './LogoWidget.css';

interface LogoWidgetProps {
  logoUrl?: string;
  position?: 'top-right' | 'bottom-right';
}

export const LogoWidget: React.FC<LogoWidgetProps> = ({ logoUrl, position = 'bottom-right' }) => {
  const [variant, setVariant] = useState<'white' | 'black' | 'red'>('white');
  const [showGradient, setShowGradient] = useState(false);
  const [showBigBug, setShowBigBug] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  // Use refs for logic loop to avoid closure staleness and double-invocation issues
  const phaseRef = React.useRef<'white-small' | 'black-small' | 'black-big' | 'red-small'>('white-small');
  const gradientRef = React.useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      // Toggle gradient logic
      if (!gradientRef.current) {
        // Step 1: Turn Gradient ON
        gradientRef.current = true;
        setShowGradient(true);
      } else {
        // Step 2: Gradient is already ON, so we move to next PHASE
        const currentPhase = phaseRef.current;

        if (currentPhase === 'white-small') {
          // -> Black Small
          phaseRef.current = 'black-small';
          setVariant('black');
          // Turn off gradient shortly
          setTimeout(() => {
            gradientRef.current = false;
            setShowGradient(false);
          }, 100);
        } else if (currentPhase === 'black-small') {
          // -> Black Big
          phaseRef.current = 'black-big';

          // Start resize
          setIsResizing(true);
          gradientRef.current = false;
          setShowGradient(false);

          setTimeout(() => {
            setShowBigBug(true);
            setIsResizing(false);
          }, 800);
        } else if (currentPhase === 'black-big') {
          // -> Red Small
          phaseRef.current = 'red-small';

          // Immediate switch to small bug so content is visible during shrink
          setShowBigBug(false);
          setIsResizing(false);
          gradientRef.current = false;
          setShowGradient(false);

          setTimeout(() => {
            setVariant('red');
          }, 800);
        } else if (currentPhase === 'red-small') {
          // -> White Small
          phaseRef.current = 'white-small';
          setVariant('white');

          setTimeout(() => {
            gradientRef.current = false;
            setShowGradient(false);
          }, 100);
        }
      }
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className={`logo-widget ${position} variant-${variant} ${showGradient ? 'gradient-active' : ''} ${showBigBug ? 'big-mode' : ''} ${isResizing ? 'resizing' : ''}`}
    >
      {logoUrl ? (
        <img src={logoUrl} alt='Logo' className='logo-image' />
      ) : (
        <>
          <img
            src='/bug-sm.svg'
            alt='Logo'
            className={`logo-svg logo-small ${variant === 'white' ? 'red-filter' : ''} ${showBigBug || isResizing ? 'fade-out' : 'fade-in'}`}
          />
          <img src='/bug-big.svg' alt='Logo' className={`logo-svg logo-big ${showBigBug && !isResizing ? 'fade-in' : 'fade-out'}`} />
        </>
      )}
    </div>
  );
};
