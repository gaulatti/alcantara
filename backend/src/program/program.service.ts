import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ProgramService {
  private eventSubject = new Subject<any>();

  constructor(private prisma: PrismaService) {
    this.initializeProgramState();
  }

  private async initializeProgramState() {
    const existingState = await this.prisma.programState.findFirst();
    if (!existingState) {
      await this.prisma.programState.create({
        data: { activeSceneId: null },
      });
    }
  }

  async getState() {
    const state = await this.prisma.programState.findFirst({
      include: {
        activeScene: {
          include: { layout: true },
        },
      },
    });
    return state;
  }

  async activateScene(sceneId: number) {
    const scene = await this.prisma.scene.findUnique({
      where: { id: sceneId },
      include: { layout: true },
    });

    if (!scene) {
      throw new Error('Scene not found');
    }

    const state = await this.prisma.programState.findFirst();

    if (!state) {
      throw new Error('Program state not initialized');
    }

    const updatedState = await this.prisma.programState.update({
      where: { id: state.id },
      data: { activeSceneId: sceneId },
      include: {
        activeScene: {
          include: { layout: true },
        },
      },
    });

    this.broadcastUpdate({
      type: 'scene_change',
      state: updatedState,
    });

    return updatedState;
  }

  broadcastUpdate(data: any) {
    this.eventSubject.next(data);
  }

  getEventStream(): Observable<{ data: string }> {
    return this.eventSubject.asObservable().pipe(
      map((data) => ({
        data: JSON.stringify(data),
      })),
    );
  }
}
