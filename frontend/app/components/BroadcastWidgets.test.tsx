import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';
import { Ticker } from './Ticker';
import { QRCodeWidget } from './QRCodeWidget';
import { LogoWidget } from './LogoWidget';
import { LiveIndicator } from './LiveIndicator';
import { ClockWidget } from './ClockWidget';
import { CronicaReiteramos } from './CronicaReiteramos';
import { BroadcastLayout } from './BroadcastLayout';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T12:00:00Z')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('broadcast widget presentation contracts', () => {
  it('renders editorial header and ticker strings literally, including their documented defaults', () => {
    const { rerender } = render(<><Header /><Ticker /></>);
    expect(screen.getByText(/ModoSanremo \|/)).toHaveTextContent('01/01/2026');
    expect(screen.getByText('#ModoitalianoMR')).toBeInTheDocument();
    expect(screen.getByText('modoradio.cl')).toBeInTheDocument();
    rerender(<><Header title='Special bulletin' date='Editorial date' /><Ticker hashtag='#LocalNews' url='news.example' /></>);
    expect(screen.getByText('Special bulletin | Editorial date')).toBeInTheDocument();
    expect(screen.getByText('#LocalNews')).toBeInTheDocument();
    expect(screen.getByText('news.example')).toBeInTheDocument();
  });

  it('uses the supplied QR image over generated content and encodes content as one URL parameter', () => {
    const { rerender } = render(<QRCodeWidget qrCodeUrl='https://images.example/qr.png' content='https://news.example/?a=1&b=2' />);
    expect(screen.getByRole('img', { name: 'QR Code' })).toHaveAttribute('src', 'https://images.example/qr.png');
    rerender(<QRCodeWidget content='https://news.example/?a=1&b=2' />);
    const generated = new URL(screen.getByRole('img', { name: 'QR Code' }).getAttribute('src')!);
    expect(generated.searchParams.get('data')).toBe('https://news.example/?a=1&b=2');
    expect(generated.searchParams.get('b')).toBeNull();
  });

  it('shows the QR placeholder only when requested and contains malformed-content encoding failures', () => {
    const { rerender, container } = render(<QRCodeWidget />);
    expect(container.querySelectorAll('.qr-cell')).toHaveLength(9);
    rerender(<QRCodeWidget placeholder={false} />);
    expect(container.querySelector('.qr-placeholder')).not.toBeInTheDocument();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    rerender(<QRCodeWidget content={'\uD800'} />);
    expect(error).toHaveBeenCalledWith('Failed to generate QR code:', expect.any(URIError));
    expect(container.querySelector('.qr-placeholder')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('honors live animation and explicit reiteration visibility', () => {
    const { rerender, container } = render(<><LiveIndicator /><CronicaReiteramos /></>);
    expect(container.querySelector('.live-badge')).toHaveClass('animate');
    expect(screen.getByText('REITERAMOS')).toBeInTheDocument();
    rerender(<><LiveIndicator animate={false} /><CronicaReiteramos text='Actualización' show={false} /></>);
    expect(container.querySelector('.live-badge')).not.toHaveClass('animate');
    expect(screen.queryByText('Actualización')).not.toBeInTheDocument();
    rerender(<CronicaReiteramos text='Actualización' />);
    expect(screen.getByText('Actualización')).toBeInTheDocument();
  });

  it('updates the actual clock in its selected timezone and releases its ticking interval', () => {
    const { rerender, container, unmount } = render(<ClockWidget timezone='America/New_York' iconUrl='/clock.svg' />);
    expect(container.querySelector('.clock-time')).toHaveTextContent('07:00');
    expect(screen.getByRole('img', { name: 'icon' })).toHaveAttribute('src', '/clock.svg');
    act(() => vi.advanceTimersByTime(60000));
    expect(container.querySelector('.clock-time')).toHaveTextContent('07:01');
    rerender(<ClockWidget timezone='Europe/Rome' showIcon={false} />);
    expect(container.querySelector('.clock-time')).toHaveTextContent('13:01');
    expect(container.querySelector('.clock-icon')).not.toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the persisted broadcast-time override independently of physical timezone', () => {
    const { container, rerender } = render(<ClockWidget timezone='America/New_York' timeOverride={{ startTime: '20:30', startedAt: '2026-01-01T12:00:00Z' }} />);
    expect(container.querySelector('.clock-time')).toHaveTextContent('20:30');
    act(() => vi.advanceTimersByTime(60000));
    expect(container.querySelector('.clock-time')).toHaveTextContent('20:31');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    rerender(<ClockWidget timezone='Not/AZone' timeOverride={{ startTime: 'invalid', startedAt: 'invalid' }} />);
    expect(error).toHaveBeenCalledWith('Invalid timezone:', 'Not/AZone');
    expect(container.querySelector('.clock-time')?.textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  it('composes header, child content and a controlled chyron without adding an unsupported expiry timer', () => {
    const { rerender } = render(<BroadcastLayout headerTitle='Bulletin' chyronText='Controlled caption' showChyron showLiveIndicator={false}>
      <p>Program content</p>
    </BroadcastLayout>);
    expect(screen.getByText('Program content')).toBeInTheDocument();
    expect(screen.getByText('Controlled caption')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText('Controlled caption')).toBeInTheDocument();
    rerender(<BroadcastLayout chyronText='Controlled caption' showChyron={false} />);
    expect(screen.queryByText('Controlled caption')).not.toBeInTheDocument();
  });
});

describe('logo broadcast rotation', () => {
  it('preserves an explicit logo and position', () => {
    const { container } = render(<LogoWidget logoUrl='/station.svg' position='top-right' />);
    expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute('src', '/station.svg');
    expect(container.querySelector('.logo-widget')).toHaveClass('top-right');
  });

  it('rotates the normal station bug through white, black, enlarged, red and white phases', () => {
    const { container, unmount } = render(<LogoWidget />);
    const widget = container.querySelector('.logo-widget');
    expect(widget).toHaveClass('variant-white');
    expect(container.querySelector('.logo-small')).toHaveClass('red-filter', 'fade-in');
    act(() => vi.advanceTimersByTime(10000));
    expect(widget).toHaveClass('gradient-active');
    act(() => vi.advanceTimersByTime(10100));
    expect(widget).toHaveClass('variant-black');
    expect(widget).not.toHaveClass('gradient-active');
    act(() => vi.advanceTimersByTime(20000));
    expect(widget).toHaveClass('resizing');
    act(() => vi.advanceTimersByTime(800));
    expect(widget).toHaveClass('big-mode');
    expect(container.querySelector('.logo-big')).toHaveClass('fade-in');
    act(() => vi.advanceTimersByTime(20000));
    expect(widget).toHaveClass('variant-red');
    expect(widget).not.toHaveClass('big-mode');
    act(() => vi.advanceTimersByTime(20000));
    expect(widget).toHaveClass('variant-white');
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(vi.getTimerCount()).toBe(0);
  });
});
