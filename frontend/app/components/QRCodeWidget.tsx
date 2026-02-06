import React, { useEffect, useState } from 'react';
import './QRCodeWidget.css';

interface QRCodeWidgetProps {
  qrCodeUrl?: string;
  placeholder?: boolean;
  content?: string;
}

export const QRCodeWidget: React.FC<QRCodeWidgetProps> = ({ qrCodeUrl, placeholder = true, content }) => {
  const [generatedQR, setGeneratedQR] = useState<string>('');

  useEffect(() => {
    if (content && !qrCodeUrl) {
      // Generate QR code from content
      generateQRCode(content);
    }
  }, [content, qrCodeUrl]);

  const generateQRCode = async (text: string) => {
    try {
      // Using a simple QR code generation approach with an API
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
      setGeneratedQR(qrUrl);
    } catch (error) {
      console.error('Failed to generate QR code:', error);
    }
  };

  const displayQR = qrCodeUrl || generatedQR;

  return (
    <div className='qr-widget'>
      {displayQR ? (
        <img src={displayQR} alt='QR Code' className='qr-image' />
      ) : placeholder ? (
        <div className='qr-placeholder'>
          <div className='qr-pattern'>
            {/* Simple QR-like pattern */}
            <div className='qr-grid'>
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className='qr-cell' />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
