import { Module } from '@nestjs/common';
import { CertificatesService } from './certificates.service';

@Module({
  providers: [CertificatesService],
  exports: [CertificatesService],
})
export class CertificatesModule {}
