import { useEffect } from 'react';

/**
 * The UI kit paints an opaque background on <html>, and the root layout paints <body>.
 * Browser-source capture (OBS) can only clear one of them, so the program renderer
 * clears both while it is mounted.
 */
export function useTransparentDocument() {
  useEffect(() => {
    const targets = [document.documentElement, document.body];
    const previous = targets.map((element) => element.style.getPropertyValue('background-color'));
    targets.forEach((element) => element.style.setProperty('background-color', 'transparent', 'important'));
    return () => {
      targets.forEach((element, index) => {
        if (previous[index]) element.style.setProperty('background-color', previous[index]);
        else element.style.removeProperty('background-color');
      });
    };
  }, []);
}
