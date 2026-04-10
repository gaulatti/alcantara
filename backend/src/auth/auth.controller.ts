import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Controller('auth')
export class AuthController {
  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  getMe(@Req() req: any) {
    // req.user is populated by JwtStrategy
    return req.user;
  }
}
