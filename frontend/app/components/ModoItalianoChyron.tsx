import React from 'react';
import { ToniChyron } from './ToniChyron';

interface ModoItalianoChyronProps {
  text?: string;
  show?: boolean;
  useMarquee?: boolean;
  label?: string;
}

export const ModoItalianoChyron: React.FC<ModoItalianoChyronProps> = ({
  text = '',
  show = true,
  useMarquee = false,
  label = 'MODO ITALIANO'
}) => {
  return <ToniChyron text={text} show={show} useMarquee={useMarquee} label={label} />;
};
