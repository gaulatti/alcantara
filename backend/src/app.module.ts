import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProgramModule } from './program/program.module';
import { ScenesModule } from './scenes/scenes.module';
import { LayoutsModule } from './layouts/layouts.module';

@Module({
  imports: [ProgramModule, ScenesModule, LayoutsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
