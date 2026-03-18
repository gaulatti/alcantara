import { BellRing } from 'lucide-react';
import { useEffect } from 'react';

interface MarqueeCurtainProps {
  onComplete: () => void;
}

export function MarqueeCurtain({ onComplete }: MarqueeCurtainProps) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      onComplete();
    }, 5000);

    return () => window.clearTimeout(timer);
  }, [onComplete]);

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '50px',
        backgroundColor: '#b21100',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        zIndex: 100,
        animation: 'fadeIn 0.3s ease-in-out'
      }}
    >
      <BellRing size={24} strokeWidth={2} color='#ffffff' />
      <span
        style={{
          color: '#ffffff',
          fontSize: '1.5rem',
          fontWeight: '600',
          fontFamily: 'Libre Franklin, sans-serif'
        }}
      >
        This is fifth<span style={{ fontWeight: '700' }}>bell</span>.
      </span>
      <BellRing size={24} strokeWidth={2} color='#ffffff' />
    </div>
  );
}
