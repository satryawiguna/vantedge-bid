import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isDemoModeEnabled } from '../../config/demo-mode';

/**
 * Keeps demo-only routes out of any environment that has not explicitly asked
 * for them. This is the protection — it runs on every request, so it does not
 * depend on Swagger visibility or on the start-up check alone.
 *
 * It fails closed: the configured flag must be true AND the environment must
 * still resolve as demo-safe when re-evaluated here. Anything else answers 404,
 * the same response as a route that does not exist, so a deployment with demo
 * mode off does not reveal that the endpoint is there.
 */
@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    const configured = this.config.get<boolean>('app.demoEnabled', false) === true;
    if (configured && isDemoModeEnabled(process.env)) return true;
    throw new NotFoundException();
  }
}
