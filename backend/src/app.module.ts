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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
