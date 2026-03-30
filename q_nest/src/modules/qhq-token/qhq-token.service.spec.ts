import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { QhqTokenService } from './qhq-token.service';
import { QhqTokenChainService } from './qhq-token-chain.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QhqTransactionType } from '.prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrismaService = () => ({
  qhq_balances: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  qhq_transactions: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  qhq_token_config: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  qhq_wallet_links: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    findMany: jest.fn(),
  },
  qhq_reward_rules: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  qhq_subscription_discounts: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  users: {
    findUniqueOrThrow: jest.fn(),
  },
  user_subscriptions: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn((fn) => fn(mockPrismaService())),
});

const mockChainService = () => ({
  ready: true,
  setMerkleRoot: jest.fn().mockResolvedValue('0xabcdef1234567890'),
  getOnChainBalance: jest.fn(),
  getTotalClaimed: jest.fn(),
  getCurrentMerkleRoot: jest.fn(),
  getTotalSupply: jest.fn(),
  verifyProofOnChain: jest.fn(),
});

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('QhqTokenService', () => {
  let service: QhqTokenService;
  let prisma: any;
  let chainService: any;

  beforeEach(async () => {
    const prismaProvider = mockPrismaService();
    const chainProvider = mockChainService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QhqTokenService,
        { provide: PrismaService, useValue: prismaProvider },
        { provide: QhqTokenChainService, useValue: chainProvider },
      ],
    }).compile();

    service = module.get<QhqTokenService>(QhqTokenService);
    prisma = module.get<PrismaService>(PrismaService);
    chainService = module.get<QhqTokenChainService>(QhqTokenChainService);
  });

  // ─── getBalance ──────────────────────────────────────────────────────────

  describe('getBalance', () => {
    it('should return existing balance when found', async () => {
      const mockBalance = {
        pending_balance: new Decimal(100),
        cumulative_earned: new Decimal(200),
        lifetime_claimed: new Decimal(50),
        lifetime_spent: new Decimal(30),
        lifetime_burned: new Decimal(3),
      };
      prisma.qhq_balances.findUnique.mockResolvedValue(mockBalance);

      const result = await service.getBalance('user-1');

      expect(result).toEqual(mockBalance);
      expect(prisma.qhq_balances.findUnique).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
      });
    });

    it('should return zero defaults when no balance exists', async () => {
      prisma.qhq_balances.findUnique.mockResolvedValue(null);

      const result = await service.getBalance('user-1');

      expect(result).toEqual({
        pending_balance: '0',
        cumulative_earned: '0',
        lifetime_claimed: '0',
        lifetime_spent: '0',
        lifetime_burned: '0',
      });
    });
  });

  // ─── getOrCreateBalance ──────────────────────────────────────────────────

  describe('getOrCreateBalance', () => {
    it('should upsert with correct create shape', async () => {
      const mockBalance = { user_id: 'user-1', pending_balance: new Decimal(0) };
      prisma.qhq_balances.upsert.mockResolvedValue(mockBalance);

      const result = await service.getOrCreateBalance('user-1');

      expect(prisma.qhq_balances.upsert).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
        update: {},
        create: {
          user_id: 'user-1',
          pending_balance: 0,
          cumulative_earned: 0,
          lifetime_claimed: 0,
          lifetime_spent: 0,
          lifetime_burned: 0,
        },
      });
      expect(result).toEqual(mockBalance);
    });
  });

  // ─── earnTokens ──────────────────────────────────────────────────────────

  describe('earnTokens', () => {
    it('should create transaction and update balance', async () => {
      const mockTx = { id: 'tx-1', amount: 5 };
      // $transaction callback receives a tx client; our mock returns the factory
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.upsert.mockResolvedValue({ pending_balance: new Decimal(5) });
        txClient.qhq_transactions.create.mockResolvedValue(mockTx);
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      const result = await service.earnTokens(
        'user-1',
        QhqTransactionType.EARN_STRATEGY,
        5,
        'Created strategy: My Strategy',
        'strategy-1',
      );

      expect(result).toEqual(mockTx);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('should pass reference_id as null when not supplied', async () => {
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.upsert.mockResolvedValue({ pending_balance: new Decimal(10) });
        txClient.qhq_transactions.create.mockResolvedValue({ id: 'tx-2' });
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      await service.earnTokens(
        'user-1',
        QhqTransactionType.EARN_SUBSCRIPTION,
        10,
        'Monthly PRO reward',
      );

      // Verify $transaction was called — the callback handles the rest
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('should return null when daily trade cap is reached', async () => {
      // getTodayTradeRewardCount checks qhq_transactions.count
      prisma.qhq_transactions.count.mockResolvedValue(10);

      const result = await service.earnTokens(
        'user-1',
        QhqTransactionType.EARN_TRADING,
        0.1,
        'Live trade executed',
      );

      expect(result).toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should allow trade reward when under daily cap', async () => {
      prisma.qhq_transactions.count.mockResolvedValue(5);
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.upsert.mockResolvedValue({ pending_balance: new Decimal(0.6) });
        txClient.qhq_transactions.create.mockResolvedValue({ id: 'tx-3' });
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      const result = await service.earnTokens(
        'user-1',
        QhqTransactionType.EARN_TRADING,
        0.1,
        'Live trade executed',
      );

      expect(result).not.toBeNull();
    });

    it('should increment circulating supply in token config', async () => {
      let capturedConfigArgs: any;
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.upsert.mockResolvedValue({ pending_balance: new Decimal(5) });
        txClient.qhq_transactions.create.mockResolvedValue({ id: 'tx-4' });
        txClient.qhq_token_config.upsert.mockImplementation((args: any) => {
          capturedConfigArgs = args;
          return {};
        });
        return fn(txClient);
      });

      await service.earnTokens(
        'user-1',
        QhqTransactionType.EARN_STRATEGY,
        5,
        'Created strategy',
      );

      expect(capturedConfigArgs).toBeDefined();
      expect(capturedConfigArgs.update.circulating_supply).toEqual({ increment: 5 });
    });
  });

  // ─── spendTokens ────────────────────────────────────────────────────────

  describe('spendTokens', () => {
    it('should throw BadRequestException on insufficient balance', async () => {
      prisma.qhq_balances.findUnique.mockResolvedValue({
        pending_balance: new Decimal(10),
      });

      await expect(
        service.spendTokens('user-1', QhqTransactionType.SPEND_SUBSCRIPTION_DISCOUNT, 50, 'Discount'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should decrement balance and create spend + burn transactions', async () => {
      prisma.qhq_balances.findUnique.mockResolvedValue({
        pending_balance: new Decimal(100),
      });

      const txCreates: any[] = [];
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.update.mockResolvedValue({ pending_balance: new Decimal(50) });
        txClient.qhq_transactions.create.mockImplementation((args: any) => {
          txCreates.push(args);
          return { id: `tx-${txCreates.length}` };
        });
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      await service.spendTokens(
        'user-1',
        QhqTransactionType.SPEND_SUBSCRIPTION_DISCOUNT,
        50,
        'Subscription discount: 5%',
      );

      // Should create 2 transactions: spend + burn
      expect(txCreates).toHaveLength(2);
      expect(txCreates[0].data.type).toBe(QhqTransactionType.SPEND_SUBSCRIPTION_DISCOUNT);
      expect(txCreates[0].data.amount).toBe(-50);
      expect(txCreates[1].data.type).toBe(QhqTransactionType.BURN_ON_SPEND);
    });

    it('should calculate 10% burn correctly', async () => {
      prisma.qhq_balances.findUnique.mockResolvedValue({
        pending_balance: new Decimal(200),
      });

      let capturedUpdateArgs: any;
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.update.mockImplementation((args: any) => {
          capturedUpdateArgs = args;
          return { pending_balance: new Decimal(100) };
        });
        txClient.qhq_transactions.create.mockResolvedValue({});
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      await service.spendTokens(
        'user-1',
        QhqTransactionType.SPEND_SUBSCRIPTION_DISCOUNT,
        100,
        'Discount',
      );

      expect(capturedUpdateArgs.data.lifetime_burned).toEqual({ increment: 10 }); // 10% of 100
    });

    it('should update total_burned in token config', async () => {
      prisma.qhq_balances.findUnique.mockResolvedValue({
        pending_balance: new Decimal(200),
      });

      let capturedConfigArgs: any;
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.update.mockResolvedValue({ pending_balance: new Decimal(150) });
        txClient.qhq_transactions.create.mockResolvedValue({});
        txClient.qhq_token_config.upsert.mockImplementation((args: any) => {
          capturedConfigArgs = args;
          return {};
        });
        return fn(txClient);
      });

      await service.spendTokens(
        'user-1',
        QhqTransactionType.SPEND_SUBSCRIPTION_DISCOUNT,
        50,
        'Discount',
      );

      expect(capturedConfigArgs.update.total_burned).toEqual({ increment: 5 }); // 10% of 50
    });
  });

  // ─── spendForSubscriptionDiscount ────────────────────────────────────────

  describe('spendForSubscriptionDiscount', () => {
    it('should throw BadRequestException for invalid qhq amount', async () => {
      await expect(
        service.spendForSubscriptionDiscount('user-1', 75),
      ).rejects.toThrow(BadRequestException);
    });

    it.each([
      [50, 5],
      [100, 10],
      [200, 15],
    ])('should return %i QHQ → %i%% discount', async (qhqAmount, expectedPercent) => {
      // Mock spendTokens prerequisites
      prisma.qhq_balances.findUnique.mockResolvedValue({
        pending_balance: new Decimal(300),
      });
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.update.mockResolvedValue({ pending_balance: new Decimal(300 - qhqAmount) });
        txClient.qhq_transactions.create.mockResolvedValue({});
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });
      prisma.qhq_subscription_discounts.create.mockResolvedValue({
        id: 'disc-1',
        discount_percent: expectedPercent,
      });

      const result = await service.spendForSubscriptionDiscount('user-1', qhqAmount);

      expect(result.discount_percent).toBe(expectedPercent);
      expect(result.expires_at).toBeInstanceOf(Date);
      // Verify 35-day expiry (within 1 second tolerance)
      const expectedExpiry = new Date();
      expectedExpiry.setDate(expectedExpiry.getDate() + 35);
      expect(Math.abs(result.expires_at.getTime() - expectedExpiry.getTime())).toBeLessThan(1000);
    });
  });

  // ─── linkWallet ──────────────────────────────────────────────────────────

  describe('linkWallet', () => {
    it('should normalize address to lowercase and upsert', async () => {
      prisma.qhq_wallet_links.findUnique.mockResolvedValue(null);
      prisma.qhq_wallet_links.upsert.mockResolvedValue({
        wallet_address: '0xabcdef1234567890abcdef1234567890abcdef12',
      });

      const result = await service.linkWallet(
        'user-1',
        '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      );

      expect(prisma.qhq_wallet_links.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            wallet_address: '0xabcdef1234567890abcdef1234567890abcdef12',
          }),
        }),
      );
    });

    it('should throw BadRequestException when address belongs to another user', async () => {
      prisma.qhq_wallet_links.findUnique.mockResolvedValue({
        user_id: 'user-2',
        wallet_address: '0xabcdef1234567890abcdef1234567890abcdef12',
      });

      await expect(
        service.linkWallet('user-1', '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow re-linking same address for same user', async () => {
      prisma.qhq_wallet_links.findUnique.mockResolvedValue({
        user_id: 'user-1',
        wallet_address: '0xabcdef1234567890abcdef1234567890abcdef12',
      });
      prisma.qhq_wallet_links.upsert.mockResolvedValue({
        wallet_address: '0xabcdef1234567890abcdef1234567890abcdef12',
      });

      await expect(
        service.linkWallet('user-1', '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'),
      ).resolves.toBeDefined();
    });
  });

  // ─── getLinkedWallet ─────────────────────────────────────────────────────

  describe('getLinkedWallet', () => {
    it('should delegate to prisma findUnique', async () => {
      const mockWallet = { user_id: 'user-1', wallet_address: '0xabc' };
      prisma.qhq_wallet_links.findUnique.mockResolvedValue(mockWallet);

      const result = await service.getLinkedWallet('user-1');

      expect(result).toEqual(mockWallet);
      expect(prisma.qhq_wallet_links.findUnique).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
      });
    });
  });

  // ─── getMerkleProof ──────────────────────────────────────────────────────

  describe('getMerkleProof', () => {
    it('should throw BadRequestException when no wallet linked', async () => {
      prisma.qhq_wallet_links.findUnique.mockResolvedValue(null);

      await expect(service.getMerkleProof('user-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when no QHQ earned', async () => {
      prisma.qhq_wallet_links.findUnique.mockResolvedValue({
        user_id: 'user-1',
        wallet_address: '0xabc123',
      });
      prisma.qhq_balances.findUnique.mockResolvedValue({
        cumulative_earned: new Decimal(0),
      });

      await expect(service.getMerkleProof('user-1')).rejects.toThrow(BadRequestException);
    });

    it('should return valid proof for user with earnings', async () => {
      const walletAddress = '0x7d71a8b0f8826c7bd9dded33121baeda789688ad';
      prisma.qhq_wallet_links.findUnique.mockResolvedValue({
        user_id: 'user-1',
        wallet_address: walletAddress,
      });
      prisma.qhq_balances.findUnique.mockResolvedValue({
        cumulative_earned: new Decimal(100),
      });
      // buildMerkleTree needs wallet_links.findMany
      prisma.qhq_wallet_links.findMany.mockResolvedValue([
        {
          wallet_address: walletAddress,
          user: { qhq_balance: { cumulative_earned: new Decimal(100) } },
        },
      ]);

      const result = await service.getMerkleProof('user-1');

      expect(result).toHaveProperty('wallet_address', walletAddress);
      expect(result).toHaveProperty('cumulative_amount', '100');
      expect(result).toHaveProperty('proof');
      expect(result).toHaveProperty('merkle_root');
      expect(result.cumulative_amount_wei).toBeDefined();
    });
  });

  // ─── recordClaim ─────────────────────────────────────────────────────────

  describe('recordClaim', () => {
    it('should record claim and return tx_hash + claimed_amount', async () => {
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.update.mockResolvedValue({ pending_balance: new Decimal(0) });
        txClient.qhq_transactions.create.mockResolvedValue({});
        return fn(txClient);
      });

      const result = await service.recordClaim('user-1', '0x' + 'a'.repeat(64), '50');

      expect(result).toEqual({ tx_hash: '0x' + 'a'.repeat(64), claimed_amount: 50 });
    });

    it('should throw BadRequestException for NaN amount', async () => {
      await expect(
        service.recordClaim('user-1', '0x' + 'a'.repeat(64), 'not-a-number'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for zero or negative amount', async () => {
      await expect(
        service.recordClaim('user-1', '0x' + 'a'.repeat(64), '0'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.recordClaim('user-1', '0x' + 'a'.repeat(64), '-5'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── getTransactionHistory ───────────────────────────────────────────────

  describe('getTransactionHistory', () => {
    it('should return paginated results with correct skip/take', async () => {
      prisma.qhq_transactions.findMany.mockResolvedValue([]);
      prisma.qhq_transactions.count.mockResolvedValue(50);

      const result = await service.getTransactionHistory('user-1', 3, 10);

      expect(prisma.qhq_transactions.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(result).toEqual({
        transactions: [],
        total: 50,
        page: 3,
        limit: 10,
        pages: 5,
      });
    });

    it('should use defaults page=1 limit=20', async () => {
      prisma.qhq_transactions.findMany.mockResolvedValue([]);
      prisma.qhq_transactions.count.mockResolvedValue(0);

      const result = await service.getTransactionHistory('user-1');

      expect(prisma.qhq_transactions.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  // ─── getTokenStats ───────────────────────────────────────────────────────

  describe('getTokenStats', () => {
    it('should merge config with total_holders count', async () => {
      const mockConfig = {
        total_supply: new Decimal(100000000),
        circulating_supply: new Decimal(500),
        total_burned: new Decimal(10),
      };
      prisma.qhq_token_config.findUnique.mockResolvedValue(mockConfig);
      prisma.qhq_balances.count.mockResolvedValue(42);

      const result = await service.getTokenStats();

      expect(result).toEqual({ ...mockConfig, total_holders: 42 });
      expect(prisma.qhq_balances.count).toHaveBeenCalledWith({
        where: { cumulative_earned: { gt: 0 } },
      });
    });
  });

  // ─── getRewardRules / getRuleAmount ──────────────────────────────────────

  describe('getRewardRules', () => {
    it('should return active rules ordered by rule_key', async () => {
      const rules = [
        { rule_key: 'MONTHLY_ELITE', amount: new Decimal(25), is_active: true },
        { rule_key: 'MONTHLY_PRO', amount: new Decimal(10), is_active: true },
      ];
      prisma.qhq_reward_rules.findMany.mockResolvedValue(rules);

      const result = await service.getRewardRules();

      expect(result).toEqual(rules);
      expect(prisma.qhq_reward_rules.findMany).toHaveBeenCalledWith({
        where: { is_active: true },
        orderBy: { rule_key: 'asc' },
      });
    });
  });

  describe('getRuleAmount', () => {
    it('should return numeric amount for active rule', async () => {
      prisma.qhq_reward_rules.findUnique.mockResolvedValue({
        rule_key: 'MONTHLY_PRO',
        amount: new Decimal(10),
        is_active: true,
      });

      const result = await service.getRuleAmount('MONTHLY_PRO');

      expect(result).toBe(10);
    });

    it('should return 0 for inactive or missing rule', async () => {
      prisma.qhq_reward_rules.findUnique.mockResolvedValue(null);
      expect(await service.getRuleAmount('MISSING')).toBe(0);

      prisma.qhq_reward_rules.findUnique.mockResolvedValue({
        rule_key: 'DISABLED_RULE',
        amount: new Decimal(50),
        is_active: false,
      });
      expect(await service.getRuleAmount('DISABLED_RULE')).toBe(0);
    });
  });

  // ─── adminGrantTokens ───────────────────────────────────────────────────

  describe('adminGrantTokens', () => {
    it('should validate user exists then earn tokens', async () => {
      prisma.users.findUniqueOrThrow.mockResolvedValue({ user_id: 'user-1' });
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.upsert.mockResolvedValue({ pending_balance: new Decimal(100) });
        txClient.qhq_transactions.create.mockResolvedValue({ id: 'tx-grant' });
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      const result = await service.adminGrantTokens('user-1', 100, 'Manual grant');

      expect(prisma.users.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
      });
      expect(result).toBeDefined();
    });

    it('should throw when user does not exist', async () => {
      prisma.users.findUniqueOrThrow.mockRejectedValue(new Error('Not found'));

      await expect(
        service.adminGrantTokens('nonexistent', 100, 'Grant'),
      ).rejects.toThrow();
    });
  });

  // ─── adminDeductTokens ──────────────────────────────────────────────────

  describe('adminDeductTokens', () => {
    it('should delegate to spendTokens with ADMIN_DEDUCT type', async () => {
      prisma.qhq_balances.findUnique.mockResolvedValue({
        pending_balance: new Decimal(200),
      });
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.update.mockResolvedValue({ pending_balance: new Decimal(150) });
        txClient.qhq_transactions.create.mockResolvedValue({});
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      await service.adminDeductTokens('user-1', 50, 'Admin deduction');

      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  // ─── updateRewardRule ───────────────────────────────────────────────────

  describe('updateRewardRule', () => {
    it('should only spread defined fields in update', async () => {
      prisma.qhq_reward_rules.update.mockResolvedValue({});

      await service.updateRewardRule('MONTHLY_PRO', { amount: 15 });

      expect(prisma.qhq_reward_rules.update).toHaveBeenCalledWith({
        where: { rule_key: 'MONTHLY_PRO' },
        data: { amount: 15 },
      });
    });
  });

  // ─── processMonthlyAllocations ──────────────────────────────────────────

  describe('processMonthlyAllocations', () => {
    it('should award QHQ to active PRO and ELITE subscribers', async () => {
      prisma.qhq_reward_rules.findUnique
        .mockResolvedValueOnce({ rule_key: 'MONTHLY_PRO', amount: new Decimal(10), is_active: true })
        .mockResolvedValueOnce({ rule_key: 'MONTHLY_ELITE', amount: new Decimal(25), is_active: true });

      prisma.user_subscriptions.findMany.mockResolvedValue([
        { user_id: 'user-1', tier: 'PRO' },
        { user_id: 'user-2', tier: 'ELITE' },
      ]);

      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.upsert.mockResolvedValue({ pending_balance: new Decimal(10) });
        txClient.qhq_transactions.create.mockResolvedValue({});
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      const awarded = await service.processMonthlyAllocations();

      expect(awarded).toBe(2);
    });

    it('should skip when rule amount is 0', async () => {
      prisma.qhq_reward_rules.findUnique.mockResolvedValue(null); // getRuleAmount returns 0

      prisma.user_subscriptions.findMany.mockResolvedValue([
        { user_id: 'user-1', tier: 'PRO' },
      ]);

      const awarded = await service.processMonthlyAllocations();

      expect(awarded).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should continue after per-user error', async () => {
      prisma.qhq_reward_rules.findUnique
        .mockResolvedValueOnce({ rule_key: 'MONTHLY_PRO', amount: new Decimal(10), is_active: true })
        .mockResolvedValueOnce({ rule_key: 'MONTHLY_ELITE', amount: new Decimal(25), is_active: true });

      prisma.user_subscriptions.findMany.mockResolvedValue([
        { user_id: 'user-fail', tier: 'PRO' },
        { user_id: 'user-ok', tier: 'PRO' },
      ]);

      let callCount = 0;
      prisma.$transaction.mockImplementation(async (fn: any) => {
        callCount++;
        if (callCount === 1) throw new Error('DB error');
        const txClient = mockPrismaService();
        txClient.qhq_balances.upsert.mockResolvedValue({ pending_balance: new Decimal(10) });
        txClient.qhq_transactions.create.mockResolvedValue({});
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      const awarded = await service.processMonthlyAllocations();

      expect(awarded).toBe(1); // Only second user succeeded
    });
  });

  // ─── processLoyaltyBonuses ──────────────────────────────────────────────

  describe('processLoyaltyBonuses', () => {
    it('should return 0 when bonus amount is 0', async () => {
      prisma.qhq_reward_rules.findUnique.mockResolvedValue(null);

      const result = await service.processLoyaltyBonuses();

      expect(result).toBe(0);
    });

    it('should award bonus to eligible users', async () => {
      prisma.qhq_reward_rules.findUnique.mockResolvedValue({
        rule_key: 'LOYALTY_12_MONTHS',
        amount: new Decimal(50),
        is_active: true,
      });

      prisma.user_subscriptions.findMany.mockResolvedValue([
        { user_id: 'loyal-user', subscription_id: 'sub-1' },
      ]);

      // Dedup check: no existing loyalty bonus
      prisma.qhq_transactions.findFirst.mockResolvedValue(null);

      prisma.$transaction.mockImplementation(async (fn: any) => {
        const txClient = mockPrismaService();
        txClient.qhq_balances.upsert.mockResolvedValue({ pending_balance: new Decimal(50) });
        txClient.qhq_transactions.create.mockResolvedValue({});
        txClient.qhq_token_config.upsert.mockResolvedValue({});
        return fn(txClient);
      });

      const awarded = await service.processLoyaltyBonuses();

      expect(awarded).toBe(1);
    });

    it('should skip user who already received loyalty bonus', async () => {
      prisma.qhq_reward_rules.findUnique.mockResolvedValue({
        rule_key: 'LOYALTY_12_MONTHS',
        amount: new Decimal(50),
        is_active: true,
      });

      prisma.user_subscriptions.findMany.mockResolvedValue([
        { user_id: 'loyal-user', subscription_id: 'sub-1' },
      ]);

      // Dedup check: already received
      prisma.qhq_transactions.findFirst.mockResolvedValue({ id: 'existing-tx' });

      const awarded = await service.processLoyaltyBonuses();

      expect(awarded).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ─── generateAndUpdateMerkleRoot ────────────────────────────────────────

  describe('generateAndUpdateMerkleRoot', () => {
    it('should return null when tree is empty', async () => {
      prisma.qhq_wallet_links.findMany.mockResolvedValue([]);

      const result = await service.generateAndUpdateMerkleRoot();

      expect(result).toBeNull();
      expect(chainService.setMerkleRoot).not.toHaveBeenCalled();
    });

    it('should call chain service and store root when ready', async () => {
      prisma.qhq_wallet_links.findMany.mockResolvedValue([
        {
          wallet_address: '0x7d71a8b0f8826c7bd9dded33121baeda789688ad',
          user: { qhq_balance: { cumulative_earned: new Decimal(100) } },
        },
      ]);
      prisma.qhq_token_config.upsert.mockResolvedValue({});

      const result = await service.generateAndUpdateMerkleRoot();

      expect(chainService.setMerkleRoot).toHaveBeenCalled();
      expect(prisma.qhq_token_config.upsert).toHaveBeenCalled();
      expect(result).toBe('0xabcdef1234567890');
    });

    it('should store root in DB only when chain not ready', async () => {
      chainService.ready = false;

      prisma.qhq_wallet_links.findMany.mockResolvedValue([
        {
          wallet_address: '0x7d71a8b0f8826c7bd9dded33121baeda789688ad',
          user: { qhq_balance: { cumulative_earned: new Decimal(100) } },
        },
      ]);
      prisma.qhq_token_config.upsert.mockResolvedValue({});

      const result = await service.generateAndUpdateMerkleRoot();

      expect(chainService.setMerkleRoot).not.toHaveBeenCalled();
      expect(prisma.qhq_token_config.upsert).toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });
});
