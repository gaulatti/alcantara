import React from 'react';
import { Earone as BleeckerEarone, type EaroneProps } from '../bleecker';

/** The partner's logo, served from the app's public folder; the library ships no artwork. */
const EARONE_LOGO_URL = '/earone.svg';

export const Earone: React.FC<Omit<EaroneProps, 'logoUrl'>> = (props) => (
  <BleeckerEarone {...props} logoUrl={EARONE_LOGO_URL} />
);
