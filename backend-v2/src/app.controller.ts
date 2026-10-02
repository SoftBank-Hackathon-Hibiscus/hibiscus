import { Controller, Get, SetMetadata } from '@nestjs/common';
import { PUBLIC_ROUTE } from './auth/types/auth.type.js';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('healthz')
  @SetMetadata(PUBLIC_ROUTE, true)
  getHealth() {
    return this.appService.getHealth();
  }
}
