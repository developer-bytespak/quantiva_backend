import { Test, TestingModule } from '@nestjs/testing';
import { QhqTokenController } from './qhq-token.controller';
import { QhqTokenService } from './qhq-token.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockQhqService = () => ({
  getBalance: jest.fn().mockResolvedValue({ pending_balance: '100' }),
  getTransactionHistory: jest.fn().mockResolvedValue({ transactions: [], total: 0, page: 1, limit: 20, pages: 0 }),
  getLinkedWallet: jest.fn().mockResolvedValue({ wallet_address: '0xabc' }),
  linkWallet: jest.fn().mockResolvedValue({ wallet_address: '0xabc' }),
  getMerkleProof: jest.fn().mockResolvedValue({ proof: [], merkle_root: '0x123' }),
  recordClaim: jest.fn().mockResolvedValue({ tx_hash: '0xdef', claimed_amount: 50 }),
  spendForSubscriptionDiscount: jest.fn().mockResolvedValue({ discount_percent: 5 }),
  getPendingDiscount: jest.fn().mockResolvedValue(null),
  getTokenStats: jest.fn().mockResolvedValue({ total_supply: '100000000' }),
  getRewardRules: jest.fn().mockResolvedValue([]),
});

const mockUser = { user_id: 'user-1', email: 'test@test.com' };

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('QhqTokenController', () => {
  let controller: QhqTokenController;
  let qhqService: any;

  beforeEach(async () => {
    const serviceProvider = mockQhqService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [QhqTokenController],
      providers: [
        { provide: QhqTokenService, useValue: serviceProvider },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<QhqTokenController>(QhqTokenController);
    qhqService = module.get<QhqTokenService>(QhqTokenService);
  });

  describe('GET /qhq/balance', () => {
    it('should call getBalance with user_id', async () => {
      await controller.getBalance(mockUser);
      expect(qhqService.getBalance).toHaveBeenCalledWith('user-1');
    });
  });

  describe('GET /qhq/transactions', () => {
    it('should parse page and limit strings to integers', async () => {
      await controller.getTransactions(mockUser, '3', '15');
      expect(qhqService.getTransactionHistory).toHaveBeenCalledWith('user-1', 3, 15);
    });
  });

  describe('GET /qhq/wallet', () => {
    it('should call getLinkedWallet with user_id', async () => {
      await controller.getWallet(mockUser);
      expect(qhqService.getLinkedWallet).toHaveBeenCalledWith('user-1');
    });
  });

  describe('POST /qhq/wallet/link', () => {
    it('should pass wallet_address to linkWallet', async () => {
      await controller.linkWallet(mockUser, { wallet_address: '0xABC123' } as any);
      expect(qhqService.linkWallet).toHaveBeenCalledWith('user-1', '0xABC123');
    });
  });

  describe('GET /qhq/claim/proof', () => {
    it('should call getMerkleProof with user_id', async () => {
      await controller.getClaimProof(mockUser);
      expect(qhqService.getMerkleProof).toHaveBeenCalledWith('user-1');
    });
  });

  describe('POST /qhq/claim/confirm', () => {
    it('should pass tx_hash and amount to recordClaim', async () => {
      const dto = { tx_hash: '0x' + 'a'.repeat(64), amount: '50' } as any;
      await controller.confirmClaim(mockUser, dto);
      expect(qhqService.recordClaim).toHaveBeenCalledWith('user-1', dto.tx_hash, '50');
    });
  });

  describe('POST /qhq/spend/subscription-discount', () => {
    it('should pass qhq_amount to spendForSubscriptionDiscount', async () => {
      await controller.spendForDiscount(mockUser, { qhq_amount: 100 } as any);
      expect(qhqService.spendForSubscriptionDiscount).toHaveBeenCalledWith('user-1', 100);
    });
  });

  describe('GET /qhq/discount', () => {
    it('should call getPendingDiscount with user_id', async () => {
      await controller.getPendingDiscount(mockUser);
      expect(qhqService.getPendingDiscount).toHaveBeenCalledWith('user-1');
    });
  });

  describe('GET /qhq/stats', () => {
    it('should call getTokenStats', async () => {
      await controller.getStats();
      expect(qhqService.getTokenStats).toHaveBeenCalled();
    });
  });

  describe('GET /qhq/reward-rules', () => {
    it('should call getRewardRules', async () => {
      await controller.getRewardRules();
      expect(qhqService.getRewardRules).toHaveBeenCalled();
    });
  });
});
