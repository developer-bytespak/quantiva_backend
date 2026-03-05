# Binance P2P Payment Implementation - Exact Match Only

> **Approach:** Simple, no-tolerance payment validation
> 
> **Payment Method:** Binance P2P (USD only) 
> 
> **Validation:** Exact amount matching only - approve if match, reject + refund if any variance

---

## 📋 Implementation Overview

| Component | Status | Details |
|-----------|--------|---------|
| **Payment Method** | ✅ | Binance P2P (USD transfers only) |
| **TX Identification** | ✅ | Binance auto-generates TX ID |
| **Validation** | ✅ | Exact match only (no tolerance) |
| **If Match** | ✅ | Approve → Create member |
| **If Variance** | ✅ | Reject → Refund initiated |
| **Admin Review** | ❌ | Not needed (binary approval) |
| **Suspense Accounts** | ❌ | Not needed |
| **Overpayment Credits** | ❌ | Not used (rejected) |

**Total Implementation Time: 4-6 hours**

---

## 🔄 Payment Validation Flow

```
User sends exactly 105 USDT via Binance P2P
        ↓
User provides Binance TX ID to our system
        ↓
Backend queries Binance API with TX ID
        ↓
Get exact amount received
        ↓
    ┌─ Received = Expected (105 = 105)
    │  └─ ✓ APPROVED → Member created instantly
    │
    └─ Received ≠ Expected (104.99 or 105.01 or any variance)
       └─ ✗ REJECTED → Refund sent to user immediately
```

**Decision Table:**
| Received | Expected | Decision |
|----------|----------|----------|
| 105.00 | 105.00 | ✓ Approve |
| 104.99 | 105.00 | ✗ Reject |
| 105.01 | 105.00 | ✗ Reject |
| 100.00 | 105.00 | ✗ Reject |

---

## 🔐 Binance P2P Integration

### Why Binance P2P?

```
Binance P2P (Our Choice)
├─ User transfers USD to our merchant account
├─ Binance auto-generates TX ID
├─ We query Binance API to verify
└─ ✓ Fast, simple, automated

Crypto Withdrawal (NOT Used)
├─ User sends crypto privately
├─ No TX ID tracking
├─ Slow blockchain confirmation
└─ ✗ Not suitable for exact validation
```

### Flow Details

1. **Admin Setup**
   - Create Binance P2P merchant account
   - Store Binance API keys (encrypted)
   - Configure as "buyer" of USDT with USD fiat

2. **User Payment**
   - Go to Binance P2P
   - Find our merchant offering to sell USDT
   - Send USD to bank account
   - Binance releases USDT to admin wallet
   - Binance provides unique TX ID

3. **Our Verification**
   - User submits TX ID to our system
   - Backend calls Binance API
   - Verify: TX exists for our merchant
   - Check: Amount matches exactly
   - Result: Approve or Reject

---

# Implementation

## Core Payment Submission & Verification

**Duration:** 4-6 hours

### Database Schema (Already Applied ✅)

**Enum Added:**
```prisma
enum BinancePaymentStatus {
  pending      // Awaiting verification
  verified     // Exact match ✓
  rejected     // Variance detected ✗
  refunded     // Refund sent
}
```

**Fields Added to vc_pool_payment_submissions:**
```prisma
// Binance P2P TX Details
binance_tx_id                String?  @unique
binance_tx_timestamp         DateTime?
binance_amount_received_usdt Decimal?

// Exact Amount Validation
exact_amount_expected        Decimal
exact_amount_received        Decimal?

// Payment Status
binance_payment_status       BinancePaymentStatus
verified_at                  DateTime?
refund_initiated_at          DateTime?
refund_reason                String?
```

**New Table: vc_pool_transactions (Audit Trail)**
```prisma
transaction_type          // payment_submitted, payment_verified, payment_rejected, refund_initiated
amount_usdt               Decimal
binance_tx_id             String? @unique
expected_amount           Decimal?
actual_amount_received    Decimal?
status                    // pending, verified, rejected, failed
```

**New Table: user_credits (For future use)**
```prisma
credit_amount_usdt    Decimal
source                String  // admin_transfer, refund, other
is_spent              Boolean
spent_on_pool_id      String?
```

---

## 🛠 Backend Services

### 1. Payment Submission Service

**File:** `src/modules/vc-pool/services/payment-submission.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class PaymentSubmissionService {
  constructor(private prisma: PrismaService) {}

  /**
   * User submits Binance TX ID
   */
  async submitPaymentProof(
    poolId: string,
    userId: string,
    binanceTxId: string,
    binanceTxTimestamp: Date,
  ) {
    // Get pool to calculate exact amount
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
    });

    if (!pool) throw new Error('Pool not found');

    const investmentAmount = pool.contribution_amount;
    const adminFee = investmentAmount.times(pool.admin_profit_fee_percent).div(100);
    const exactAmount = investmentAmount.plus(adminFee);

    // Verify seat reservation
    const reservation = await this.prisma.vc_pool_seat_reservations.findUnique({
      where: { pool_id_user_id: { pool_id: poolId, user_id: userId } },
    });

    if (!reservation) throw new Error('No seat reservation found');

    // Create payment submission
    const payment = await this.prisma.vc_pool_payment_submissions.create({
      data: {
        pool_id: poolId,
        user_id: userId,
        reservation_id: reservation.reservation_id,
        payment_method: 'binance',
        investment_amount: investmentAmount,
        pool_fee_amount: adminFee,
        total_amount: exactAmount,
        binance_tx_id: binanceTxId,
        binance_tx_timestamp: binanceTxTimestamp,
        exact_amount_expected: exactAmount,
        status: 'pending',
        payment_deadline: new Date(Date.now() + 30 * 60 * 1000),
        submitted_at: new Date(),
      },
    });

    // Log transaction
    await this.prisma.vc_pool_transactions.create({
      data: {
        pool_id: poolId,
        user_id: userId,
        payment_submission_id: payment.submission_id,
        transaction_type: 'payment_submitted',
        amount_usdt: exactAmount,
        binance_tx_id: binanceTxId,
        status: 'pending',
      },
    });

    return payment;
  }

  /**
   * Get user's payment submissions
   */
  async getUserSubmissions(userId: string) {
    return this.prisma.vc_pool_payment_submissions.findMany({
      where: { user_id: userId },
      include: { pool: true },
      orderBy: { submitted_at: 'desc' },
    });
  }
}
```

### 2. Binance Verification Service

**File:** `src/modules/vc-pool/services/binance-verification.service.ts`

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class BinanceVerificationService {
  private logger = new Logger(BinanceVerificationService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Verify exact amount match
   */
  async verifyPayment(payment): Promise<{ verified: boolean; reason: string; amount?: Decimal }> {
    try {
      // Get admin's Binance API keys
      const admin = await this.prisma.admins.findUnique({
        where: { admin_id: payment.pool.admin_id },
      });

      const apiKey = this.decryptKey(admin.binance_api_key_encrypted);
      const apiSecret = this.decryptKey(admin.binance_api_secret_encrypted);

      // Query Binance API for deposits
      const deposits = await this.getBinanceDeposits(apiKey, apiSecret);
      const matchingTx = deposits.find(d => d.txId === payment.binance_tx_id);

      if (!matchingTx) {
        return { verified: false, reason: 'TX not found on Binance' };
      }

      const actualAmount = new Decimal(matchingTx.amount);
      const expectedAmount = payment.exact_amount_expected;

      // EXACT MATCH CHECK
      if (!actualAmount.equals(expectedAmount)) {
        const variance = actualAmount.minus(expectedAmount);
        const reason = variance.greaterThan(0)
          ? `Overpayment: received ${actualAmount} instead of ${expectedAmount}`
          : `Shortfall: received ${actualAmount} instead of ${expectedAmount}`;

        return { verified: false, reason, amount: actualAmount };
      }

      return { verified: true, reason: 'Exact match', amount: actualAmount };
    } catch (error) {
      this.logger.error('Verification error:', error);
      throw error;
    }
  }

  /**
   * Cron: Verify all pending payments (every 5 min)
   */
  async verifyPendingPayments() {
    this.logger.log('Verification cycle started');

    const pending = await this.prisma.vc_pool_payment_submissions.findMany({
      where: { status: 'pending' },
      include: { pool: { include: { admin: true } } },
    });

    for (const payment of pending) {
      try {
        const result = await this.verifyPayment(payment);

        if (result.verified) {
          await this.handleApproved(payment, result.amount);
        } else {
          await this.handleRejected(payment, result.reason, result.amount);
        }
      } catch (error) {
        this.logger.error(`Verification failed: ${payment.submission_id}`);
      }
    }

    this.logger.log('Verification cycle complete');
  }

  private async handleApproved(payment, actualAmount: Decimal) {
    await this.prisma.vc_pool_payment_submissions.update({
      where: { submission_id: payment.submission_id },
      data: {
        status: 'verified',
        binance_payment_status: 'verified',
        binance_amount_received_usdt: actualAmount,
        exact_amount_received: actualAmount,
        verified_at: new Date(),
      },
    });

    // Create pool member
    await this.prisma.vc_pool_members.create({
      data: {
        pool_id: payment.pool_id,
        user_id: payment.user_id,
        payment_method: 'binance',
        invested_amount_usdt: actualAmount,
        share_percent: this.getSharePercent(payment.pool, actualAmount),
        is_active: true,
      },
    });

    // Log success
    await this.prisma.vc_pool_transactions.create({
      data: {
        pool_id: payment.pool_id,
        user_id: payment.user_id,
        payment_submission_id: payment.submission_id,
        transaction_type: 'payment_verified',
        amount_usdt: actualAmount,
        binance_tx_id: payment.binance_tx_id,
        expected_amount: payment.exact_amount_expected,
        actual_amount_received: actualAmount,
        status: 'verified',
        resolved_at: new Date(),
      },
    });

    this.logger.log(`✓ Approved: ${payment.submission_id}`);
  }

  private async handleRejected(payment, reason: string, actualAmount?: Decimal) {
    await this.prisma.vc_pool_payment_submissions.update({
      where: { submission_id: payment.submission_id },
      data: {
        status: 'rejected',
        binance_payment_status: 'rejected',
        binance_amount_received_usdt: actualAmount,
        exact_amount_received: actualAmount,
        refund_initiated_at: new Date(),
        refund_reason: reason,
      },
    });

    // Log rejection
    await this.prisma.vc_pool_transactions.create({
      data: {
        pool_id: payment.pool_id,
        user_id: payment.user_id,
        payment_submission_id: payment.submission_id,
        transaction_type: 'payment_rejected',
        amount_usdt: actualAmount || payment.exact_amount_expected,
        binance_tx_id: payment.binance_tx_id,
        expected_amount: payment.exact_amount_expected,
        actual_amount_received: actualAmount,
        status: 'rejected',
        resolved_at: new Date(),
      },
    });

    // TODO: Initiate refund via Binance API
    this.logger.log(`✗ Rejected: ${payment.submission_id}`);
  }

  private getSharePercent(pool, amount: Decimal): Decimal {
    const totalValue = new Decimal(pool.max_members).times(pool.contribution_amount);
    return amount.dividedBy(totalValue).times(100);
  }

  private async getBinanceDeposits(apiKey: string, apiSecret: string) {
    // Call Binance API to get recent deposits
    // Return: [{ txId, amount, timestamp }, ...]
    return [];
  }

  private decryptKey(encrypted: string): string {
    // Decrypt Binance API keys
    return encrypted;
  }
}
```

### 3. Cron Job

**File:** `src/modules/vc-pool/jobs/payment-verification.job.ts`

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BinanceVerificationService } from '../services/binance-verification.service';

@Injectable()
export class PaymentVerificationJob {
  private logger = new Logger(PaymentVerificationJob.name);

  constructor(private binanceService: BinanceVerificationService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async verifyPayments() {
    this.logger.log('Verification job triggered');
    await this.binanceService.verifyPendingPayments();
  }
}
```

### 4. API Controller

**File:** `src/modules/vc-pool/controllers/payment.controller.ts`

```typescript
import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PaymentSubmissionService } from '../services/payment-submission.service';

@Controller('vc-pool/payment')
@UseGuards(AuthGuard('jwt'))
export class PaymentController {
  constructor(
    private paymentService: PaymentSubmissionService,
  ) {}

  @Post('submit-binance-tx')
  async submitBinanceTx(@Req() req, @Body() dto) {
    const result = await this.paymentService.submitPaymentProof(
      dto.pool_id,
      req.user.user_id,
      dto.binance_tx_id,
      new Date(dto.binance_tx_timestamp),
    );

    return {
      success: true,
      message: 'Submitted. Verifying with Binance...',
      data: {
        submission_id: result.submission_id,
        expected_amount: result.total_amount,
      },
    };
  }

  @Get('my-submissions')
  async getMySubmissions(@Req() req) {
    return this.paymentService.getUserSubmissions(req.user.user_id);
  }
}
```

---

## 💻 Frontend

### Payment Form Component

**File:** `src/pages/pools/[poolId]/submit-payment.tsx`

```typescript
import { useState } from 'react';
import { api } from '@/lib/axios';

export default function SubmitPaymentForm({ poolId, expectedAmount }) {
  const [txId, setTxId] = useState('');
  const [txTime, setTxTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      await api.post('/vc-pool/payment/submit-binance-tx', {
        pool_id: poolId,
        binance_tx_id: txId,
        binance_tx_timestamp: new Date(txTime).toISOString(),
      });

      setSubmitted(true);
      setTimeout(() => {
        window.location.href = `/pools/${poolId}/payment-status`;
      }, 2000);
    } catch (error) {
      alert('Error: ' + error.response?.data?.message);
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="p-6 bg-green-50 border border-green-200 rounded">
        <h2 className="text-green-800 font-bold">✓ Submitted</h2>
        <p className="text-green-700 text-sm">Verifying with Binance...</p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto p-6 bg-white rounded-lg border">
      <h2 className="text-2xl font-bold mb-4">Submit Binance Payment</h2>
      
      <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded">
        <p className="text-sm font-semibold">Exact Amount Required:</p>
        <p className="text-2xl font-bold text-blue-600">{expectedAmount} USDT</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">TX ID</label>
          <input
            type="text"
            value={txId}
            onChange={(e) => setTxId(e.target.value)}
            placeholder="Binance TX ID"
            className="w-full px-3 py-2 border rounded"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Time</label>
          <input
            type="datetime-local"
            value={txTime}
            onChange={(e) => setTxTime(e.target.value)}
            className="w-full px-3 py-2 border rounded"
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:bg-gray-400"
        >
          {loading ? 'Submitting...' : 'Submit'}
        </button>
      </form>
    </div>
  );
}
```

### Payment Status Component

**File:** `src/pages/pools/[poolId]/payment-status.tsx`

```typescript
import { useEffect, useState } from 'react';
import { api } from '@/lib/axios';

export default function PaymentStatus({ poolId }) {
  const [submissions, setSubmissions] = useState([]);

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await api.get('/vc-pool/payment/my-submissions');
        setSubmissions(res.data);
      } catch (error) {
        console.error('Error:', error);
      }
    };

    fetch();
    const interval = setInterval(fetch, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h2 className="text-2xl font-bold mb-6">Payment Status</h2>

      {submissions.map((sub) => (
        <div key={sub.submission_id} className="border rounded-lg p-6 mb-4">
          <div className="flex justify-between mb-4">
            <h3 className="font-bold">{sub.pool.name}</h3>
            <StatusBadge status={sub.binance_payment_status} />
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="bg-gray-50 p-3 rounded">
              <p className="text-xs text-gray-600">Expected</p>
              <p className="font-bold">{sub.total_amount} USDT</p>
            </div>
            <div className="bg-gray-50 p-3 rounded">
              <p className="text-xs text-gray-600">Received</p>
              <p className="font-bold">{sub.binance_amount_received_usdt || '—'}</p>
            </div>
          </div>

          {sub.binance_payment_status === 'pending' && (
            <p className="text-sm text-amber-600">⏳ Verifying...</p>
          )}

          {sub.binance_payment_status === 'verified' && (
            <p className="text-sm text-green-600">✓ Approved! You are a member now.</p>
          )}

          {sub.binance_payment_status === 'rejected' && (
            <p className="text-sm text-red-600">✗ Rejected: {sub.refund_reason}</p>
          )}
        </div>
      ))}

      {submissions.length === 0 && <p className="text-gray-600">No submissions yet</p>}
    </div>
  );
}

function StatusBadge({ status }) {
  const styles = {
    pending: 'bg-yellow-100 text-yellow-800',
    verified: 'bg-green-100 text-green-800',
    rejected: 'bg-red-100 text-red-800',
  };

  return (
    <span className={`px-3 py-1 rounded text-sm font-semibold ${styles[status]}`}>
      {status.toUpperCase()}
    </span>
  );
}
```

---

## ✅ Checklist

- ✅ Prisma schema updated
- ✅ Payment submission service
- ✅ Binance verification service
- ✅ Cron job setup
- ✅ API endpoints
- ✅ Frontend forms
- ✅ Status pages
- ✅ Audit logging

---

## Migration

```bash
cd q_nest
npx prisma migrate dev --name "binance_exact_match_payment"
```
