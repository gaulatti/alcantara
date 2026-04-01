import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class LayoutsService {
  private readonly componentTypes = [
    {
      type: 'lower-third',
      name: 'Lower Third',
      description: 'Text overlay at the bottom of the screen',
    },
    {
      type: 'full-screen',
      name: 'Full Screen',
      description: 'Full-screen text display',
    },
    {
      type: 'slideshow',
      name: 'Slideshow',
      description: 'Full HD animated slideshow of images',
    },
    {
      type: 'video-stream',
      name: 'Video Stream',
      description: 'Full-screen video or live stream playback layer',
    },
    {
      type: 'corner-bug',
      name: 'Corner Bug',
      description: 'Small badge in the top-right corner',
    },
    {
      type: 'broadcast-layout',
      name: 'Broadcast Layout',
      description:
        'Complete broadcast layout with header, ticker, chyron, clock, QR code, and logo',
    },
    {
      type: 'ticker',
      name: 'Ticker',
      description: 'Bottom ticker bar with hashtag and URL',
    },
    {
      type: 'header',
      name: 'Header',
      description: 'Top header bar with title and date',
    },
    {
      type: 'chyron',
      name: 'Chyron',
      description: 'Animated message overlay above ticker',
    },
    {
      type: 'clock-widget',
      name: 'Clock Widget',
      description: 'Live updating clock display',
    },
    {
      type: 'qr-code',
      name: 'QR Code',
      description: 'QR code widget for viewer scanning',
    },
    {
      type: 'live-indicator',
      name: 'Live Indicator',
      description: 'Animated SVG live badge',
    },
    {
      type: 'logo-widget',
      name: 'Logo Widget',
      description: 'SVG corner bug/logo display',
    },
    {
      type: 'reloj-clock',
      name: 'Reloj Clock',
      description: 'Analog reloj clone component',
    },
    {
      type: 'reloj-loop-clock',
      name: 'Reloj Loop Clock',
      description:
        'Digital clock rotating Madrid, Sanremo, New York, Santiago every 30s',
    },
    {
      type: 'toni-chyron',
      name: 'FifthBell Chyron (Legacy)',
      description: 'Legacy alias for FifthBell chyron component',
    },
    {
      type: 'fifthbell-chyron',
      name: 'FifthBell Chyron',
      description: 'Lower-third style chyron with optional marquee behavior',
    },
    {
      type: 'toni-clock',
      name: 'Toni Clock',
      description: 'Toni-styled digital clock with optional label and seconds',
    },
    {
      type: 'toni-logo',
      name: 'Toni Logo',
      description: 'Toni-styled station logo/callsign block',
    },
    {
      type: 'earone',
      name: 'Earone',
      description:
        'Compact Toni-styled ranking box for chart position and radio spins',
    },
    {
      type: 'modoitaliano-clock',
      name: 'ModoItaliano Clock',
      description:
        'ModoItaliano corner clock block (fixed city/timezone rotation + song metadata)',
    },
    {
      type: 'modoitaliano-chyron',
      name: 'ModoItaliano Chyron',
      description:
        'ModoItaliano lower chyron strip for headline text and label',
    },
    {
      type: 'modoitaliano-disclaimer',
      name: 'ModoItaliano Disclaimer',
      description:
        'ModoItaliano legal/disclaimer text block with alignment and sizing',
    },
    {
      type: 'fifthbell-content',
      name: 'FifthBell Content',
      description:
        'FifthBell main content/slides controls (segments, playlist, callsign, weather cities)',
    },
    {
      type: 'fifthbell-marquee',
      name: 'FifthBell Marquee',
      description: 'FifthBell bottom marquee controls',
    },
    {
      type: 'fifthbell-clock',
      name: 'FifthBell Clock',
      description:
        'FifthBell standalone corner clock component (layout-selectable)',
    },
    {
      type: 'fifthbell-corner',
      name: 'FifthBell Corner (Legacy)',
      description:
        'Legacy FifthBell corner controls. Prefer using `toni-clock` in layouts.',
    },
    {
      type: 'fifthbell',
      name: 'FifthBell (Legacy)',
      description:
        'Legacy combined FifthBell component. Prefer fifthbell-content,fifthbell-marquee,toni-clock.',
    },
  ];

  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.layout.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.layout.findUnique({
      where: { id },
      include: { scenes: true },
    });
  }

  getComponentTypes() {
    return this.componentTypes;
  }

  async create(data: { name: string; componentType: string; settings?: any }) {
    return this.prisma.layout.create({
      data: {
        name: data.name,
        componentType: data.componentType,
        settings: data.settings ? JSON.stringify(data.settings) : '{}',
      },
    });
  }

  async update(
    id: number,
    data: { name?: string; componentType?: string; settings?: any },
  ) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.componentType !== undefined)
      updateData.componentType = data.componentType;
    if (data.settings !== undefined)
      updateData.settings = JSON.stringify(data.settings);

    return this.prisma.layout.update({
      where: { id },
      data: updateData,
    });
  }

  async remove(id: number) {
    return this.prisma.layout.delete({
      where: { id },
    });
  }
}
