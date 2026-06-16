import { Global, Module } from '@nestjs/common';
import { GeoipService } from './geoip.service';

@Global()
@Module({
  providers: [GeoipService],
  exports: [GeoipService],
})
export class GeoipModule {}
