import { Module } from '@nestjs/common';
import { DemoController } from './demo.controller';
import { DemoModeGuard } from './demo-mode.guard';
import { DemoService } from './demo.service';

/**
 * Demo-only, read-only directory. Registered unconditionally; DemoModeGuard
 * decides per request, so an environment without DEMO_MODE=true answers 404.
 */
@Module({
  controllers: [DemoController],
  providers: [DemoService, DemoModeGuard],
})
export class DemoModule {}
