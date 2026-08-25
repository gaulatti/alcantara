import { Controller, Get, Query } from '@nestjs/common';
import { Public } from './public.decorator';
import { TestAuthService } from './test-auth.service';

@Controller('__test')
export class TestAuthController {
  constructor(private readonly testAuth: TestAuthService) {}

  @Public()
  @Get('session')
  session(@Query('identity') identity?: string) {
    return this.testAuth.issue(identity);
  }
}
