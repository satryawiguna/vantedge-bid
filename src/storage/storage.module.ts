import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { S3StorageService } from './s3-storage.service';
import { LocalStorageService } from './local-storage.service';

/**
 * Driver selection happens once, here. Nothing downstream knows which one it
 * got — callers inject the abstract StorageService.
 */
@Global()
@Module({
  providers: [
    {
      provide: StorageService,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageService =>
        config.get<string>('storage.driver', 's3') === 'local'
          ? new LocalStorageService(config)
          : new S3StorageService(config),
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
