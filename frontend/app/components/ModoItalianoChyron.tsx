import React from 'react';

interface ModoItalianoChyronProps {
  cta?: string;
  text?: string;
  show?: boolean;
  useMarquee?: boolean;
  inline?: boolean;
}

export const ModoItalianoChyron: React.FC<ModoItalianoChyronProps> = ({
  cta = '',
  text = '',
  show = true,
  useMarquee = false,
  inline = false
}) => {
  if (!show || !text.trim()) {
    return null;
  }

  const wrapperStyle: React.CSSProperties = inline
    ? {
        width: '100%'
      }
    : {
        position: 'absolute',
        left: '110px',
        right: '110px',
        bottom: '110px',
        zIndex: 950
      };

  const boxStyle: React.CSSProperties =
    {
      height: '140px',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      borderRadius: '50px',
      overflow: 'hidden',
      background: 'linear-gradient(125deg, #2b2b2b 0%, #1a1a1a 48%, #2b2b2b 100%)',
      backgroundSize: '200% 200%',
      animation: 'modoItalianoChyronBgFlow 8s ease-in-out infinite',
      boxShadow: '0 24px 44px rgba(0, 0, 0, 0.72)',
      filter: 'drop-shadow(0 12px 24px rgba(0, 0, 0, 0.52))',
      padding: '0 34px'
    };

  const ctaText = cta.trim();
  const ctaStyle: React.CSSProperties = inline
    ? {
        width: '100%',
        marginBottom: '18px',
        paddingLeft: '34px',
        color: '#ffffff',
        fontFamily: "'Outfit', 'Encode Sans', system-ui, sans-serif",
        fontSize: '38.4px',
        fontWeight: 500,
        lineHeight: 1,
        textAlign: 'left',
        textShadow: '0 4px 18px rgba(0, 0, 0, 0.96), 0 0 28px rgba(0, 0, 0, 0.72), 0 0 10px rgba(255, 255, 255, 0.2)',
        WebkitTextStroke: '0.7px rgba(0, 0, 0, 0.5)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    : {
        width: '100%',
        marginBottom: '18px',
        paddingLeft: '34px',
        color: '#ffffff',
        fontFamily: "'Outfit', 'Encode Sans', system-ui, sans-serif",
        fontSize: '38.4px',
        fontWeight: 500,
        lineHeight: 1,
        textAlign: 'left',
        textShadow: '0 4px 18px rgba(0, 0, 0, 0.96), 0 0 28px rgba(0, 0, 0, 0.72), 0 0 10px rgba(255, 255, 255, 0.2)',
        WebkitTextStroke: '0.7px rgba(0, 0, 0, 0.5)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      };

  const contentStyle: React.CSSProperties = {
    width: '100%',
    color: '#ffffff',
    fontFamily: "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif",
    fontSize: '84px',
    fontWeight: 600,
    lineHeight: 1,
    textTransform: 'uppercase',
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textAlign: 'center',
    justifyContent: 'center'
  };

  if (useMarquee) {
    const marqueeText = text.trim().toUpperCase();
    return (
      <div style={wrapperStyle}>
        {ctaText ? <div style={ctaStyle}>{ctaText}</div> : null}
        <div style={boxStyle}>
          <style>{`
          @keyframes modoItalianoChyronBgFlow {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
          @keyframes modoItalianoChyronMarquee {
            from { transform: translateX(0); }
            to { transform: translateX(-50%); }
          }
        `}</style>
        <div style={{ ...contentStyle, overflow: 'hidden' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '96px',
              minWidth: '200%',
              animation: 'modoItalianoChyronMarquee 20s linear infinite'
            }}
          >
            <span>{marqueeText}</span>
            <span>{marqueeText}</span>
          </div>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      {ctaText ? <div style={ctaStyle}>{ctaText}</div> : null}
      <div style={boxStyle}>
        <style>{`
          @keyframes modoItalianoChyronBgFlow {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
        `}</style>
        <div style={{ ...contentStyle, textOverflow: 'ellipsis' }}>{text.trim().toUpperCase()}</div>
      </div>
    </div>
  );
};
