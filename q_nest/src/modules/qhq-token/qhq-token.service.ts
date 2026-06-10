import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QhqTokenChainService } from './qhq-token-chain.service';
// Prisma 6 re-export chain breaks with Node10 moduleResolution;
// import directly from the generated client location instead.
import { QhqTransactionType } from '.prisma/client';
import { MerkleTree } from 'merkletreejs';
import { ethers } from 'ethers';
import keccak256 from 'keccak256';

// Discount tiers: QHQ spent → discount %
const DISCOUNT_TIERS: Record<number, number> = { 50: 5, 100: 10, 200: 15 };

// Daily earning cap per user for trade rewards (anti-farming)
const DAILY_TRADE_REWARD_CAP = 10;

// One-time signup bonus for users who arrived through an affiliate referral
const REFERRAL_BONUS_QHQ = 100;
const REFERRAL_DISCOUNT_PERCENT = 10;
const REFERRAL_DISCOUNT_VALIDITY_DAYS = 35;

@Injectable()
export class QhqTokenService {
  private readonly logger = new Logger(QhqTokenService.name);

  constructor(
    private prisma: PrismaService,
    private chainService: QhqTokenChainService,
  ) {}

  // ─── Balance ─────────────────────────────────────────────────────────────

  async getBalance(userId: string) {
    const balance = await this.prisma.qhq_balances.findUnique({
      where: { user_id: userId },
    });
    return balance ?? {
      pending_balance: '0',
      cumulative_earned: '0',
      lifetime_claimed: '0',
      lifetime_spent: '0',
      lifetime_burned: '0',
    };
  }

  async getOrCreateBalance(userId: string) {
    return this.prisma.qhq_balances.upsert({
      where: { user_id: userId },
      update: {},
      create: {
        user_id: userId,
        pending_balance: 0,
        cumulative_earned: 0,
        lifetime_claimed: 0,
        lifetime_spent: 0,
        lifetime_burned: 0,
      },
    });
  }

  // ─── Earn Tokens ──────────────────────────────────────────────────────────

  /**
   * Credit QHQ to a user's off-chain pending balance.
   * Called by subscriptions, strategies, trading hooks.
   */
  async earnTokens(
    userId: string,
    type: QhqTransactionType,
    amount: number,
    description: string,
    referenceId?: string,
  ) {
    // Trade reward daily cap check
    if (type === QhqTransactionType.EARN_TRADING) {
      const todayCount = await this.getTodayTradeRewardCount(userId);
      if (todayCount >= DAILY_TRADE_REWARD_CAP) {
        this.logger.debug(`User ${userId} hit daily trade reward cap`);
        return null;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const balance = await tx.qhq_balances.upsert({
        where: { user_id: userId },
        update: {
          pending_balance: { increment: amount },
          cumulative_earned: { increment: amount },
        },
        create: {
          user_id: userId,
          pending_balance: amount,
          cumulative_earned: amount,
        },
      });

      const transaction = await tx.qhq_transactions.create({
        data: {
          user_id: userId,
          type,
          amount,
          balance_after: balance.pending_balance,
          description,
          reference_id: referenceId ?? null,
        },
      });

      // Update global circulating supply (cumulative_earned tracks total issued off-chain)
      await tx.qhq_token_config.upsert({
        where: { id: 1 },
        update: { circulating_supply: { increment: amount } },
        create: { id: 1, circulating_supply: amount },
      });

      return transaction;
    });
  }

  // ─── Spend Tokens ─────────────────────────────────────────────────────────

  /**
   * Deduct QHQ from pending balance. Burns 10% of spent amount on-chain.
   */
  async spendTokens(
    userId: string,
    type: QhqTransactionType,
    amount: number,
    description: string,
    referenceId?: string,
  ) {
    const balance = await this.getBalance(userId);
    const currentBalance = Number(balance.pending_balance);

    if (currentBalance < amount) {
      throw new BadRequestException(
        `Insufficient QHQ balance. Have ${currentBalance}, need ${amount}`,
      );
    }

    const burnAmount = Math.round(amount * 0.1 * 1e6) / 1e6; // 10% burn

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.qhq_balances.update({
        where: { user_id: userId },
        data: {
          pending_balance: { decrement: amount },
          lifetime_spent: { increment: amount },
          lifetime_burned: { increment: burnAmount },
        },
      });

      await tx.qhq_transactions.create({
        data: {
          user_id: userId,
          type,
          amount: -amount,
          balance_after: updated.pending_balance,
          description,
          reference_id: referenceId ?? null,
        },
      });

      // Record the burn transaction
      await tx.qhq_transactions.create({
        data: {
          user_id: userId,
          type: QhqTransactionType.BURN_ON_SPEND,
          amount: -burnAmount,
          balance_after: updated.pending_balance,
          description: `Burn on spend: ${description}`,
        },
      });

      await tx.qhq_token_config.upsert({
        where: { id: 1 },
        update: { total_burned: { increment: burnAmount } },
        create: { id: 1, total_burned: burnAmount },
      });

      return updated;
    });
  }

  // ─── Subscription Discount ────────────────────────────────────────────────

  async spendForSubscriptionDiscount(userId: string, qhqAmount: number) {
    const discountPercent = DISCOUNT_TIERS[qhqAmount];
    if (!discountPercent) {
      throw new BadRequestException('Invalid QHQ amount. Use 50, 100, or 200.');
    }

    await this.spendTokens(
      userId,
      QhqTransactionType.SPEND_SUBSCRIPTION_DISCOUNT,
      qhqAmount,
      `Subscription discount: ${discountPercent}% off next billing`,
    );

    // Store discount for next billing cycle (expires in 35 days)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 35);

    const discount = await this.prisma.qhq_subscription_discounts.create({
      data: {
        user_id: userId,
        qhq_spent: qhqAmount,
        discount_percent: discountPercent,
        expires_at: expiresAt,
      },
    });

    return { discount_percent: discountPercent, expires_at: expiresAt, id: discount.id };
  }

  async getPendingDiscount(userId: string) {
    return this.prisma.qhq_subscription_discounts.findFirst({
      where: {
        user_id: userId,
        applied: false,
        expires_at: { gte: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  // ─── Referral Signup Bonus ────────────────────────────────────────────────

  /**
   * Whether the current user can claim the one-time referral signup bonus.
   * Eligible = signed up through an affiliate referral and hasn't claimed yet.
   * The EARN_REFERRAL transaction itself is the claimed-flag — it's written
   * exactly once per user.
   */
  async getReferralBonusStatus(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { referred_by_affiliate_id: true },
    });
    const referred = !!user?.referred_by_affiliate_id;
    if (!referred) {
      return {
        referred: false,
        claimed: false,
        eligible: false,
        amount: REFERRAL_BONUS_QHQ,
        discount_percent: REFERRAL_DISCOUNT_PERCENT,
      };
    }
    const claimedTx = await this.prisma.qhq_transactions.findFirst({
      where: { user_id: userId, type: QhqTransactionType.EARN_REFERRAL },
      select: { id: true },
    });
    return {
      referred: true,
      claimed: !!claimedTx,
      eligible: !claimedTx,
      amount: REFERRAL_BONUS_QHQ,
      discount_percent: REFERRAL_DISCOUNT_PERCENT,
    };
  }

  /**
   * Claim the one-time referral signup bonus: credits 100 QHQ and grants a
   * 10% subscription discount that the Stripe checkout flow picks up via
   * getPendingDiscount().
   */
  async claimReferralBonus(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: {
        referred_by_affiliate_id: true,
        affiliate_referral: { select: { referral_id: true } },
      },
    });
    if (!user?.referred_by_affiliate_id) {
      throw new BadRequestException(
        'This bonus is only available to accounts created through a referral',
      );
    }

    const alreadyClaimed = await this.prisma.qhq_transactions.findFirst({
      where: { user_id: userId, type: QhqTransactionType.EARN_REFERRAL },
      select: { id: true },
    });
    if (alreadyClaimed) {
      throw new ConflictException('Referral bonus already claimed');
    }

    const transaction = await this.earnTokens(
      userId,
      QhqTransactionType.EARN_REFERRAL,
      REFERRAL_BONUS_QHQ,
      'Referral signup bonus',
      user.affiliate_referral?.referral_id,
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFERRAL_DISCOUNT_VALIDITY_DAYS);
    await this.prisma.qhq_subscription_discounts.create({
      data: {
        user_id: userId,
        qhq_spent: 0,
        discount_percent: REFERRAL_DISCOUNT_PERCENT,
        expires_at: expiresAt,
      },
    });

    return {
      claimed: true,
      amount: REFERRAL_BONUS_QHQ,
      balance_after: transaction?.balance_after,
      discount_percent: REFERRAL_DISCOUNT_PERCENT,
      discount_expires_at: expiresAt,
    };
  }

  // ─── Wallet Linking ───────────────────────────────────────────────────────

  async linkWallet(userId: string, walletAddress: string) {
    const normalized = walletAddress.toLowerCase();

    // Check if address is used by another user
    const existing = await this.prisma.qhq_wallet_links.findUnique({
      where: { wallet_address: normalized },
    });
    if (existing && existing.user_id !== userId) {
      throw new BadRequestException('Wallet address already linked to another account');
    }

    return this.prisma.qhq_wallet_links.upsert({
      where: { user_id: userId },
      update: { wallet_address: normalized, is_verified: false },
      create: { user_id: userId, wallet_address: normalized },
    });
  }

  async getLinkedWallet(userId: string) {
    return this.prisma.qhq_wallet_links.findUnique({ where: { user_id: userId } });
  }

  async unlinkWallet(userId: string) {
    const wallet = await this.getLinkedWallet(userId);
    
    if (!wallet) {
      throw new NotFoundException('No wallet linked to this account');
    }

    await this.prisma.qhq_wallet_links.delete({
      where: { user_id: userId },
    });

    return {
      success: true,
      message: 'Wallet disconnected successfully',
      wallet_address: wallet.wallet_address,
    };
  }

  // ─── Merkle Proof ─────────────────────────────────────────────────────────

  /**
   * Generate a Merkle proof for the user's current cumulative allocation.
   * The frontend uses this to call contract.claim() directly.
   */
  async getMerkleProof(userId: string) {
    const wallet = await this.getLinkedWallet(userId);
    if (!wallet) {
      throw new BadRequestException('No wallet linked. Please link your wallet first.');
    }

    const balance = await this.getBalance(userId);
    const cumulativeEarned = Number(balance.cumulative_earned);

    if (cumulativeEarned === 0) {
      throw new BadRequestException('No QHQ earned yet.');
    }

    // Rebuild Merkle tree from all users with wallets
    const { tree, leaves } = await this.buildMerkleTree();

    const leaf = this.encodeLeaf(wallet.wallet_address, cumulativeEarned);
    const proof = tree.getHexProof(leaf);

    if (proof.length === 0 && leaves.length > 1) {
      throw new BadRequestException(
        'Could not generate proof. Merkle root may be outdated — wait for next weekly update.',
      );
    }

    return {
      wallet_address: wallet.wallet_address,
      cumulative_amount: cumulativeEarned.toString(),
      cumulative_amount_wei: ethers.parseEther(cumulativeEarned.toString()).toString(),
      proof,
      merkle_root: tree.getHexRoot(),
    };
  }

  /**
   * Generate a new Merkle tree from all users and update the on-chain root.
   * Called weekly by BullMQ cron job.
   */
  async generateAndUpdateMerkleRoot(): Promise<string | null> {
    this.logger.log('Generating new Merkle root from all user allocations...');

    const { tree } = await this.buildMerkleTree();
    const newRoot = tree.getHexRoot();

    if (newRoot === '0x' || newRoot === ethers.ZeroHash) {
      this.logger.warn('Merkle tree is empty — no users with wallets yet');
      return null;
    }

    let txHash: string | null = null;
    if (this.chainService.ready) {
      txHash = await this.chainService.setMerkleRoot(newRoot);
      this.logger.log(`On-chain Merkle root updated. TX: ${txHash}`);
    } else {
      this.logger.warn('Chain service not ready — storing root only in DB');
    }

    await this.prisma.qhq_token_config.upsert({
      where: { id: 1 },
      update: { current_merkle_root: newRoot, merkle_last_updated: new Date() },
      create: { id: 1, current_merkle_root: newRoot, merkle_last_updated: new Date() },
    });

    return txHash;
  }

  // ─── Confirm On-Chain Claim ────────────────────────────────────────────────

  /**
   * Record a completed on-chain claim. Called after user submits tx on frontend.
   */
  async recordClaim(userId: string, txHash: string, claimedAmountStr: string) {
    const claimedAmount = parseFloat(claimedAmountStr);
    if (isNaN(claimedAmount) || claimedAmount <= 0) {
      throw new BadRequestException('Invalid claimed amount');
    }

    return this.prisma.$transaction(async (tx) => {
      const balance = await tx.qhq_balances.update({
        where: { user_id: userId },
        data: {
          pending_balance: { decrement: claimedAmount },
          lifetime_claimed: { increment: claimedAmount },
        },
      });

      await tx.qhq_transactions.create({
        data: {
          user_id: userId,
          type: QhqTransactionType.CLAIM_TO_WALLET,
          amount: -claimedAmount,
          balance_after: balance.pending_balance,
          description: `On-chain claim to wallet`,
          tx_hash: txHash,
        },
      });

      return { tx_hash: txHash, claimed_amount: claimedAmount };
    });
  }

  // ─── Transaction History ──────────────────────────────────────────────────

  async getTransactionHistory(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
      this.prisma.qhq_transactions.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.qhq_transactions.count({ where: { user_id: userId } }),
    ]);
    return { transactions, total, page, limit, pages: Math.ceil(total / limit) };
  }

  // ─── Global Stats ─────────────────────────────────────────────────────────

  async getTokenStats() {
    const config = await this.prisma.qhq_token_config.findUnique({ where: { id: 1 } });
    const totalUsers = await this.prisma.qhq_balances.count({
      where: { cumulative_earned: { gt: 0 } },
    });
    return { ...config, total_holders: totalUsers };
  }

  // ─── Reward Rules ─────────────────────────────────────────────────────────

  async getRewardRules() {
    return this.prisma.qhq_reward_rules.findMany({
      where: { is_active: true },
      orderBy: { rule_key: 'asc' },
    });
  }

  async getRuleAmount(ruleKey: string): Promise<number> {
    const rule = await this.prisma.qhq_reward_rules.findUnique({
      where: { rule_key: ruleKey },
    });
    if (!rule || !rule.is_active) return 0;
    return Number(rule.amount);
  }

  // ─── Monthly Allocation (BullMQ Job) ─────────────────────────────────────

  /**
   * Award monthly QHQ to all active PRO and ELITE subscribers.
   * Called by the monthly BullMQ cron job.
   */
  async processMonthlyAllocations() {
    this.logger.log('Processing monthly QHQ allocations...');

    const [proAmount, eliteAmount] = await Promise.all([
      this.getRuleAmount('MONTHLY_PRO'),
      this.getRuleAmount('MONTHLY_ELITE'),
    ]);

    const activeSubscriptions = await this.prisma.user_subscriptions.findMany({
      where: {
        status: 'active',
        tier: { in: ['PRO', 'ELITE'] },
      },
    });

    let awarded = 0;
    for (const sub of activeSubscriptions) {
      const amount = sub.tier === 'ELITE' ? eliteAmount : proAmount;
      if (amount <= 0) continue;
      try {
        await this.earnTokens(
          sub.user_id,
          QhqTransactionType.EARN_SUBSCRIPTION,
          amount,
          `Monthly ${sub.tier} subscription reward`,
        );
        awarded++;
      } catch (err) {
        this.logger.error(`Failed to award monthly tokens to ${sub.user_id}: ${err.message}`);
      }
    }

    this.logger.log(`Monthly allocation complete. Awarded ${awarded} users.`);
    return awarded;
  }

  /**
   * Check and award 12-month loyalty bonuses.
   * Called daily by BullMQ cron job.
   */
  async processLoyaltyBonuses() {
    const bonusAmount = await this.getRuleAmount('LOYALTY_12_MONTHS');
    if (bonusAmount <= 0) return 0;

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    // Find subscriptions that started exactly 12 months ago (within today's window)
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const anniversaryDate = new Date(oneYearAgo);

    const loyalSubs = await this.prisma.user_subscriptions.findMany({
      where: {
        status: 'active',
        started_at: {
          gte: new Date(anniversaryDate.getFullYear(), anniversaryDate.getMonth(), anniversaryDate.getDate()),
          lt: new Date(anniversaryDate.getFullYear(), anniversaryDate.getMonth(), anniversaryDate.getDate() + 1),
        },
      },
    });

    let awarded = 0;
    for (const sub of loyalSubs) {
      try {
        // Dedup: skip if user already received a loyalty bonus
        const existing = await this.prisma.qhq_transactions.findFirst({
          where: {
            user_id: sub.user_id,
            type: QhqTransactionType.EARN_LOYALTY_BONUS,
          },
        });
        if (existing) continue;

        await this.earnTokens(
          sub.user_id,
          QhqTransactionType.EARN_LOYALTY_BONUS,
          bonusAmount,
          '12-month loyalty bonus',
          sub.subscription_id,
        );
        awarded++;
      } catch (err) {
        this.logger.error(`Loyalty bonus error for ${sub.user_id}: ${err.message}`);
      }
    }

    this.logger.log(`Loyalty bonuses awarded to ${awarded} users.`);
    return awarded;
  }

  // ─── Admin Operations ─────────────────────────────────────────────────────

  async adminGrantTokens(userId: string, amount: number, description: string) {
    await this.prisma.users.findUniqueOrThrow({ where: { user_id: userId } });
    return this.earnTokens(userId, QhqTransactionType.ADMIN_GRANT, amount, description);
  }

  async adminDeductTokens(userId: string, amount: number, description: string) {
    return this.spendTokens(userId, QhqTransactionType.ADMIN_DEDUCT, amount, description);
  }

  async updateRewardRule(ruleKey: string, data: { amount?: number; is_active?: boolean; description?: string }) {
    return this.prisma.qhq_reward_rules.update({
      where: { rule_key: ruleKey },
      data: {
        ...(data.amount !== undefined && { amount: data.amount }),
        ...(data.is_active !== undefined && { is_active: data.is_active }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────

  private encodeLeaf(walletAddress: string, cumulativeAmount: number): Buffer {
    return Buffer.from(
      ethers.solidityPackedKeccak256(
        ['address', 'uint256'],
        [walletAddress, ethers.parseEther(cumulativeAmount.toString())],
      ).slice(2),
      'hex',
    );
  }

  private async buildMerkleTree() {
    const walletsWithEarnings = await this.prisma.qhq_wallet_links.findMany({
      include: { user: { include: { qhq_balance: true } } },
    });

    const entries = walletsWithEarnings
      .filter((w) => w.user?.qhq_balance && Number(w.user.qhq_balance.cumulative_earned) > 0)
      .map((w) => ({
        address: w.wallet_address,
        amount: Number(w.user.qhq_balance!.cumulative_earned),
      }));

    const leaves = entries.map((e) => this.encodeLeaf(e.address, e.amount));
    const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });

    return { tree, leaves, entries };
  }

  private async getTodayTradeRewardCount(userId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.prisma.qhq_transactions.count({
      where: {
        user_id: userId,
        type: QhqTransactionType.EARN_TRADING,
        created_at: { gte: startOfDay },
      },
    });
  }
}
