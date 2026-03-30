import { Test, TestingModule } from '@nestjs/testing';
import { QhqTokenScheduler } from './qhq-token.scheduler';
import { QhqTokenService } from './qhq-token.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockQhqService = () => ({
  processLoyaltyBonuses: jest.fn().mockResolvedValue(2),
  generateAndUpdateMerkleRoot: jest.fn().mockResolvedValue('0xabc123'),
});

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('QhqTokenScheduler', () => {
  let scheduler: QhqTokenScheduler;
  let qhqService: any;

  beforeEach(async () => {
    const serviceProvider = mockQhqService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QhqTokenScheduler,
        { provide: QhqTokenService, useValue: serviceProvider },
      ],
    }).compile();

    scheduler = module.get<QhqTokenScheduler>(QhqTokenScheduler);
    qhqService = module.get<QhqTokenService>(QhqTokenService);
  });

  describe('handleLoyaltyBonus', () => {
    it('should call processLoyaltyBonuses', async () => {
      await scheduler.handleLoyaltyBonus();
      expect(qhqService.processLoyaltyBonuses).toHaveBeenCalled();
    });

    it('should not throw when service errors', async () => {
      qhqService.processLoyaltyBonuses.mockRejectedValue(new Error('DB down'));
      await expect(scheduler.handleLoyaltyBonus()).resolves.toBeUndefined();
    });
  });

  describe('handleMerkleRootUpdate', () => {
    it('should call generateAndUpdateMerkleRoot', async () => {
      await scheduler.handleMerkleRootUpdate();
      expect(qhqService.generateAndUpdateMerkleRoot).toHaveBeenCalled();
    });

    it('should not throw when service errors', async () => {
      qhqService.generateAndUpdateMerkleRoot.mockRejectedValue(new Error('Chain down'));
      await expect(scheduler.handleMerkleRootUpdate()).resolves.toBeUndefined();
    });
  });
});
