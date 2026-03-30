import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { QhqTokenProcessor, QHQ_QUEUE, QHQ_JOBS } from './qhq-token.processor';
import { QhqTokenService } from './qhq-token.service';
import { ScheduleModule } from '@nestjs/schedule';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockQhqService = () => ({
  processMonthlyAllocations: jest.fn().mockResolvedValue(5),
  processLoyaltyBonuses: jest.fn().mockResolvedValue(2),
  generateAndUpdateMerkleRoot: jest.fn().mockResolvedValue('0xabc123'),
});

const mockQueue = () => ({
  add: jest.fn().mockResolvedValue({}),
});

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('QhqTokenProcessor', () => {
  let processor: QhqTokenProcessor;
  let qhqService: any;
  let queue: any;

  beforeEach(async () => {
    const serviceProvider = mockQhqService();
    const queueProvider = mockQueue();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QhqTokenProcessor,
        { provide: QhqTokenService, useValue: serviceProvider },
        { provide: getQueueToken(QHQ_QUEUE), useValue: queueProvider },
      ],
    }).compile();

    processor = module.get<QhqTokenProcessor>(QhqTokenProcessor);
    qhqService = module.get<QhqTokenService>(QhqTokenService);
    queue = module.get(getQueueToken(QHQ_QUEUE));
  });

  // ─── process() dispatch ──────────────────────────────────────────────────

  describe('process', () => {
    it('should route MONTHLY_ALLOCATION to processMonthlyAllocations', async () => {
      const job = { name: QHQ_JOBS.MONTHLY_ALLOCATION } as any;

      const result = await processor.process(job);

      expect(qhqService.processMonthlyAllocations).toHaveBeenCalled();
      expect(result).toBe(5);
    });

    it('should route LOYALTY_BONUS to processLoyaltyBonuses', async () => {
      const job = { name: QHQ_JOBS.LOYALTY_BONUS } as any;

      const result = await processor.process(job);

      expect(qhqService.processLoyaltyBonuses).toHaveBeenCalled();
      expect(result).toBe(2);
    });

    it('should route UPDATE_MERKLE_ROOT to generateAndUpdateMerkleRoot', async () => {
      const job = { name: QHQ_JOBS.UPDATE_MERKLE_ROOT } as any;

      const result = await processor.process(job);

      expect(qhqService.generateAndUpdateMerkleRoot).toHaveBeenCalled();
      expect(result).toBe('0xabc123');
    });

    it('should not throw for unknown job name', async () => {
      const job = { name: 'unknown-job' } as any;

      await expect(processor.process(job)).resolves.toBeUndefined();
    });
  });

  // ─── Cron schedule triggers ──────────────────────────────────────────────

  describe('scheduleMonthlyAllocation', () => {
    it('should add MONTHLY_ALLOCATION job with 3 attempts and exponential backoff', async () => {
      await processor.scheduleMonthlyAllocation();

      expect(queue.add).toHaveBeenCalledWith(
        QHQ_JOBS.MONTHLY_ALLOCATION,
        {},
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    });
  });

  describe('scheduleLoyaltyBonus', () => {
    it('should add LOYALTY_BONUS job with 3 attempts', async () => {
      await processor.scheduleLoyaltyBonus();

      expect(queue.add).toHaveBeenCalledWith(
        QHQ_JOBS.LOYALTY_BONUS,
        {},
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    });
  });

  describe('scheduleMerkleRootUpdate', () => {
    it('should add UPDATE_MERKLE_ROOT job with 5 attempts and 10s delay', async () => {
      await processor.scheduleMerkleRootUpdate();

      expect(queue.add).toHaveBeenCalledWith(
        QHQ_JOBS.UPDATE_MERKLE_ROOT,
        {},
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 10000 },
        },
      );
    });
  });
});
