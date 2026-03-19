import React from 'react';

interface ModoItalianoDisclaimerProps {
  text?: string;
  show?: boolean;
  align?: 'left' | 'center' | 'right';
  bottomPx?: number;
  fontSizePx?: number;
  opacity?: number;
  inline?: boolean;
}

export const ModoItalianoDisclaimer: React.FC<ModoItalianoDisclaimerProps> = ({
  text = '',
  show = true,
  align = 'right',
  bottomPx = 24,
  fontSizePx = 20,
  opacity = 0.82,
  inline = false
}) => {
  if (!show || !text.trim()) {
    return null;
  }

  if (inline) {
    return (
      <div
        style={{
          height: '140px',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: align === 'left' ? 'flex-start' : align === 'center' ? 'center' : 'flex-end',
          padding: '0 34px',
          borderRadius: '50px',
          background: '#2B2B2B',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
          fontFamily: "'Encode Sans', system-ui, sans-serif",
          fontSize: `${Math.max(10, fontSizePx)}px`,
          fontWeight: 600,
          letterSpacing: '0.03em',
          color: '#f3f3f3',
          textShadow: '0 2px 6px rgba(0, 0, 0, 0.55)',
          opacity: Math.min(1, Math.max(0, opacity))
        }}
      >
        {text}
      </div>
    );
  }

  const horizontalStyles =
    align === 'left'
      ? { left: '56px', textAlign: 'left' as const }
      : align === 'center'
        ? { left: '50%', transform: 'translateX(-50%)', textAlign: 'center' as const }
        : { right: '56px', textAlign: 'right' as const };

  return (
    <div
      style={{
        position: 'absolute',
        bottom: `${Math.max(0, bottomPx)}px`,
        zIndex: 900,
        fontFamily: "'Encode Sans', system-ui, sans-serif",
        fontSize: `${Math.max(10, fontSizePx)}px`,
        fontWeight: 600,
        letterSpacing: '0.03em',
        color: '#f3f3f3',
        textShadow: '0 2px 6px rgba(0, 0, 0, 0.55)',
        opacity: Math.min(1, Math.max(0, opacity)),
        pointerEvents: 'none',
        ...horizontalStyles
      }}
    >
      {text}
    </div>
  );
};
