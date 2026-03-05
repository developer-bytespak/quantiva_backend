import { Test, TestingModule } from '@nestjs/testing';
import { PaymentSubmissionService } from '../services/payment-submission.service';
import { BinanceVerificationService } from '../services/binance-verification.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

// ─── Mocks ───

const mockPrismaService = () => ({
  vc_pool_seat_reservations: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  vc_pool_payment_submissions: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  vc_pools: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  vc_pool_transactions: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
  vc_pool_members: {
    create: jest.fn(),
  },
  admins: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn((fn) => fn(mockPrismaService())),
});

// ─── PaymentSubmissionService Tests ───

describe('PaymentSubmissionService', () => {
  let service: PaymentSubmissionService;
  let prisma: any;

  beforeEach(async () => {
    const prismaProvider = mockPrismaService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentSubmissionService,
        { provide: PrismaService, useValue: prismaProvider },
      ],
    }).compile();

    service = module.get<PaymentSubmissionService>(PaymentSubmissionService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('submitBinanceTxId', () => {
    const userId = 'user-uuid-1';
    const poolId = 'pool-uuid-1';
    const binanceTxId = 'TX123456789';
    const binanceTxTimestamp = new Date('2026-03-06T10:00:00Z');

    it('should throw NotFoundException if no reservation found', async () => {
      prisma.vc_pool_seat_reservations.findUnique.mockResolvedValue(null);

      await expect(
        service.submitBinanceTxId(userId, poolId, binanceTxId, binanceTxTimestamp),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if reservation is not "reserved"', async () => {
      prisma.vc_pool_seat_reservations.findUnique.mockResolvedValue({
        reservation_id: 'res-1',
        status: 'expired',
        expires_at: new Date('2099-01-01'),
        payment_method: 'binance',
      });

      await expect(
        service.submitBinanceTxId(userId, poolId, binanceTxId, binanceTxTimestamp),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if reservation has expired', async () => {
      prisma.vc_pool_seat_reservations.findUnique.mockResolvedValue({
        reservation_id: 'res-1',
        status: 'reserved',
        expires_at: new Date('2020-01-01'), // Already expired
        payment_method: 'binance',
      });

      await expect(
        service.submitBinanceTxId(userId, poolId, binanceTxId, binanceTxTimestamp),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if no payment submission exists', async () => {
      prisma.vc_pool_seat_reservations.findUnique.mockResolvedValue({
        reservation_id: 'res-1',
        status: 'reserved',
        expires_at: new Date('2099-01-01'),
        payment_method: 'binance',
      });
      prisma.vc_pool_payment_submissions.findFirst.mockResolvedValue(null);

      await expect(
        service.submitBinanceTxId(userId, poolId, binanceTxId, binanceTxTimestamp),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if payment is not pending', async () => {
      prisma.vc_pool_seat_reservations.findUnique.mockResolvedValue({
        reservation_id: 'res-1',
        status: 'reserved',
        expires_at: new Date('2099-01-01'),
        payment_method: 'binance',
      });
      prisma.vc_pool_payment_submissions.findFirst.mockResolvedValue({
        submission_id: 'sub-1',
        status: 'processing',
      });

      await expect(
        service.submitBinanceTxId(userId, poolId, binanceTxId, binanceTxTimestamp),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException if TX ID already used', async () => {
      prisma.vc_pool_seat_reservations.findUnique.mockResolvedValue({
        reservation_id: 'res-1',
        status: 'reserved',
        expires_at: new Date('2099-01-01'),
        payment_method: 'binance',
      });
      prisma.vc_pool_payment_submissions.findFirst.mockResolvedValue({
        submission_id: 'sub-1',
        status: 'pending',
      });
      prisma.vc_pool_payment_submissions.findUnique.mockResolvedValue({
        submission_id: 'sub-other', // Different submission already uses this TX ID
      });

      await expect(
        service.submitBinanceTxId(userId, poolId, binanceTxId, binanceTxTimestamp),
      ).rejects.toThrow(ConflictException);
    });

    it('should successfully submit TX ID and return confirmation', async () => {
      const pool = {
        pool_id: poolId,
        contribution_amount: new Decimal(100),
        pool_fee_percent: new Decimal(5),
        name: 'Test Pool',
      };

      prisma.vc_pool_seat_reservations.findUnique.mockResolvedValue({
        reservation_id: 'res-1',
        status: 'reserved',
        expires_at: new Date('2099-01-01'),
        payment_method: 'binance',
      });
      prisma.vc_pool_payment_submissions.findFirst.mockResolvedValue({
        submission_id: 'sub-1',
        status: 'pending',
      });
      prisma.vc_pool_payment_submissions.findUnique.mockResolvedValue(null); // No duplicate TX
      prisma.vc_pools.findUnique.mockResolvedValue(pool);
      prisma.vc_pool_payment_submissions.update.mockResolvedValue({
        submission_id: 'sub-1',
        binance_tx_id: binanceTxId,
        status: 'processing',
      });
      prisma.vc_pool_transactions.create.mockResolvedValue({});

      const result = await service.submitBinanceTxId(
        userId,
        poolId,
        binanceTxId,
        binanceTxTimestamp,
      );

      expect(result).toHaveProperty('submission_id', 'sub-1');
      expect(result).toHaveProperty('binance_tx_id', binanceTxId);
      expect(result).toHaveProperty('status', 'processing');
      expect(result).toHaveProperty('exact_amount_expected', 105); // 100 + 5%
      expect(prisma.vc_pool_payment_submissions.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { submission_id: 'sub-1' },
          data: expect.objectContaining({
            binance_tx_id: binanceTxId,
            status: 'processing',
            binance_payment_status: 'pending',
          }),
        }),
      );
    });
  });

  describe('getUserSubmissions', () => {
    it('should return mapped submissions for a user', async () => {
      prisma.vc_pool_payment_submissions.findMany.mockResolvedValue([
        {
          submission_id: 'sub-1',
          pool_id: 'pool-1',
          payment_method: 'binance',
          total_amount: new Decimal(105),
          investment_amount: new Decimal(100),
          pool_fee_amount: new Decimal(5),
          binance_tx_id: 'TX123',
          status: 'processing',
          binance_payment_status: 'pending',
          exact_amount_expected: new Decimal(105),
          exact_amount_received: null,
          refund_reason: null,
          rejection_reason: null,
          verified_at: null,
          submitted_at: new Date(),
          payment_deadline: new Date(),
          pool: { pool_id: 'pool-1', name: 'Test Pool', contribution_amount: 100, coin_type: 'USDT' },
        },
      ]);

      const result = await service.getUserSubmissions('user-1');

      expect(result).toHaveLength(1);
      expect(result[0].pool_name).toBe('Test Pool');
      expect(result[0].binance_tx_id).toBe('TX123');
    });
  });
});

// ─── BinanceVerificationService Tests ───

describe('BinanceVerificationService', () => {
  let service: BinanceVerificationService;
  let prisma: any;

  beforeEach(async () => {
    const prismaProvider = mockPrismaService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BinanceVerificationService,
        { provide: PrismaService, useValue: prismaProvider },
      ],
    }).compile();

    service = module.get<BinanceVerificationService>(BinanceVerificationService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('verifyPayment', () => {
    it('should return verified:false if no TX ID provided', async () => {
      const result = await service.verifyPayment({
        submission_id: 'sub-1',
        binance_tx_id: null,
        pool: { admin_id: 'admin-1' },
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('No Binance TX ID provided');
    });

    it('should return verified:false if admin has no Binance API keys', async () => {
      prisma.admins.findUnique.mockResolvedValue({
        admin_id: 'admin-1',
        binance_api_key_encrypted: null,
        binance_api_secret_encrypted: null,
      });

      const result = await service.verifyPayment({
        submission_id: 'sub-1',
        binance_tx_id: 'TX123',
        pool: { admin_id: 'admin-1' },
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('API keys not configured');
    });
  });

  describe('verifyPendingPayments', () => {
    it('should return zero stats when no pending payments', async () => {
      prisma.vc_pool_payment_submissions.findMany.mockResolvedValue([]);

      const result = await service.verifyPendingPayments();

      expect(result).toEqual({
        processed: 0,
        approved: 0,
        rejected: 0,
        errors: 0,
      });
    });
  });
});
