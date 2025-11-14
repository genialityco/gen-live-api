import { Test, TestingModule } from '@nestjs/testing';
import { RtdbService } from './rtdb.service';

describe('RtdbService', () => {
  let service: RtdbService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RtdbService],
    }).compile();

    service = module.get<RtdbService>(RtdbService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
