import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProgramModule } from './program/program.module';
import { ScenesModule } from './scenes/scenes.module';
import { LayoutsModule } from './layouts/layouts.module';
import { ChartsModule } from './charts/charts.module';
import { UploadsModule } from './uploads/uploads.module';
import { SongsModule } from './songs/songs.module';
import { InstantsModule } from './instants/instants.module';
import { MediaModule } from './media/media.module';
import { MediaGroupsModule } from './media-groups/media-groups.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ProgramModule,
    ScenesModule,
    LayoutsModule,
    ChartsModule,
    UploadsModule,
    SongsModule,
    InstantsModule,
    MediaModule,
    MediaGroupsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
