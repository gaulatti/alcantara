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
      description: 'Animated LIVE/VIVO badge',
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
