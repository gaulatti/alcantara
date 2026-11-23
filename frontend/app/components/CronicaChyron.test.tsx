import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CronicaChyron } from './CronicaChyron';

// gaulatti/alcantara#183: the Crónica chyron.

afterEach(cleanup);

it('shows each line of the text on its own row', () => {
  render(<CronicaChyron text={'URGENTE\nSe cortó la luz'} />);
  expect(screen.getByText('URGENTE')).toHaveClass('cronica-chyron-line');
  expect(screen.getByText('Se cortó la luz')).toHaveClass('cronica-chyron-line');
});

it('shows nothing without text', () => {
  expect(render(<CronicaChyron />).container).toBeEmptyDOMElement();
});
