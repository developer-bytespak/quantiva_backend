import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../../../prisma/prisma.service';
import { TokenService, TokenPayload } from './token.service';
import { SessionService } from './session.service';
import { TwoFactorService } from './two-factor.service';
import { RateLimitService } from './rate-limit.service';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { Verify2FADto } from '../dto/verify-2fa.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { DeleteAccountDto } from '../dto/delete-account.dto';
import { StorageService } from '../../../storage/storage.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private tokenService: TokenService,
    private sessionService: SessionService,
    private twoFactorService: TwoFactorService,
    private rateLimitService: RateLimitService,
    private configService: ConfigService,
    private storageService: StorageService,
  ) {}

  private getGoogleClient() {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID') || process.env.GOOGLE_CLIENT_ID;
    return new OAuth2Client(clientId);
  }

  async register(registerDto: RegisterDto) {
    const { email, username, password } = registerDto;

    // Check if user already exists
    const existingUser = await this.prisma.users.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });

    if (existingUser) {
      if (existingUser.email === email) {
        throw new ConflictException('Email already registered');
      }
      if (existingUser.username === username) {
        throw new ConflictException('Username already taken');
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Generate TOTP secret for 2FA
    const twoFactorSecret = this.twoFactorService.generateTOTPSecret();

    // Create user
    const user = await this.prisma.users.create({
      data: {
        email,
        username,
        password_hash: passwordHash,
        two_factor_enabled: true,
        two_factor_secret: twoFactorSecret,
      },
    });

    return {
      user: {
        user_id: user.user_id,
        email: user.email,
        username: user.username,
        email_verified: user.email_verified,
        kyc_status: user.kyc_status,
      },
      message: 'User registered successfully. 2FA is enabled.',
    };
  }

  async login(loginDto: LoginDto, ipAddress?: string) {
    const { emailOrUsername, password } = loginDto;

    // Check rate limit
    if (ipAddress) {
      this.rateLimitService.checkRateLimit(ipAddress);
    }

    // Find user by email or username
    const user = await this.prisma.users.findFirst({
      where: {
        OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
      },
    });

    if (!user || !user.password_hash) {
      if (ipAddress) {
        this.rateLimitService.recordFailedAttempt(ipAddress);
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      if (ipAddress) {
        this.rateLimitService.recordFailedAttempt(ipAddress);
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate and send 2FA code
    const code = await this.twoFactorService.generateCode(user.user_id, 'login');
    await this.twoFactorService.sendCodeByEmail(user.email, code);

    // Record successful attempt (clears rate limit)
    if (ipAddress) {
      this.rateLimitService.recordSuccessfulAttempt(ipAddress);
    }

    return {
      requires2FA: true,
      message: '2FA code sent to your email',
    };
  }

  async verify2FA(
    verify2FADto: Verify2FADto,
    ipAddress?: string,
    deviceId?: string,
  ) {
    const { emailOrUsername, code } = verify2FADto;

    // Find user
    const user = await this.prisma.users.findFirst({
      where: {
        OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Validate 2FA code
    const isValid = await this.twoFactorService.validateCode(
      user.user_id,
      code,
      'login',
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    // Create session first to get session_id
    const refreshToken = await this.tokenService.generateRefreshToken({
      sub: user.user_id,
      email: user.email,
      username: user.username,
    });
    
    const sessionId = await this.sessionService.createSession(
      user.user_id,
      refreshToken,
      ipAddress,
      deviceId,
    );

    // Generate tokens with session_id included
    const payload: TokenPayload = {
      sub: user.user_id,
      email: user.email,
      username: user.username,
      session_id: sessionId,
    };

    const accessToken = await this.tokenService.generateAccessToken(payload);

    return {
      user: {
        user_id: user.user_id,
        email: user.email,
        username: user.username,
        email_verified: user.email_verified,
        kyc_status: user.kyc_status,
      },
      accessToken,
      refreshToken,
      sessionId,
    };
  }

  async refresh(refreshToken: string) {
    // Clean up expired sessions first
    await this.sessionService.cleanupExpiredSessions();

    // Find session by refresh token (this also validates JWT expiry)
    const session = await this.sessionService.findSessionByRefreshToken(
      refreshToken,
    );

    if (!session) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Get user
    const user = await this.prisma.users.findUnique({
      where: { user_id: session.user_id },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Generate new tokens with session_id included
    const newRefreshToken = await this.tokenService.generateRefreshToken({
      sub: user.user_id,
      email: user.email,
      username: user.username,
    });

    // Update session with new refresh token (rotation) and extend expiry
    await this.sessionService.updateSessionRefreshToken(
      session.session_id,
      newRefreshToken,
    );

    // Extend session expiry date
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + 7); // 7 days
    await this.prisma.user_sessions.update({
      where: { session_id: session.session_id },
      data: { expires_at: newExpiresAt },
    });

    // Generate access token with session_id
    const payload: TokenPayload = {
      sub: user.user_id,
      email: user.email,
      username: user.username,
      session_id: session.session_id,
    };

    const newAccessToken = await this.tokenService.generateAccessToken(payload);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  async logout(sessionId: string) {
    await this.sessionService.revokeSession(sessionId);
    return { message: 'Logged out successfully' };
  }

  async requestPasswordChangeCode(userId: string) {
    // Get user
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Generate and send 2FA code
    const code = await this.twoFactorService.generateCode(
      userId,
      'password_change',
    );
    await this.twoFactorService.sendCodeByEmail(user.email, code);

    return {
      message: '2FA code sent to your email',
    };
  }

  async changePassword(userId: string, changePasswordDto: ChangePasswordDto) {
    const { oldPassword, newPassword, twoFactorCode } = changePasswordDto;

    // Get user
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
    });

    if (!user || !user.password_hash) {
      throw new UnauthorizedException('User not found');
    }

    // Verify old password
    const isPasswordValid = await bcrypt.compare(
      oldPassword,
      user.password_hash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid current password');
    }

    // Verify 2FA code
    const isValid = await this.twoFactorService.validateCode(
      userId,
      twoFactorCode,
      'password_change',
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await this.prisma.users.update({
      where: { user_id: userId },
      data: { password_hash: newPasswordHash },
    });

    return { message: 'Password changed successfully' };
  }

  async getUserById(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        email: true,
        username: true,
        full_name: true,
        dob: true,
        nationality: true,
        gender: true,
        phone_number: true,
        email_verified: true,
        kyc_status: true,
        created_at: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  // Google Sign-in: verify id token, find or create user, create session + tokens
  async loginWithGoogle(idToken: string, ipAddress?: string, deviceId?: string) {
    if (!idToken) throw new BadRequestException('Missing idToken');

    const client = this.getGoogleClient();
    let payload: any;
    try {
      const ticket = await client.verifyIdToken({ idToken });
      payload = ticket.getPayload();
    } catch (err) {
      throw new UnauthorizedException('Invalid Google id token');
    }

    if (!payload || !payload.email) {
      throw new UnauthorizedException('Invalid Google token payload');
    }

    if (!payload.email_verified) {
      // depending on policy you may still allow, but safer to require verified
      throw new UnauthorizedException('Google account email is not verified');
    }

    const email: string = payload.email;
    const name: string = payload.name || null;
    const picture: string = payload.picture || null;

    // Try find existing user by email
    let user = await this.prisma.users.findUnique({ where: { email } });

    let isNewUser = false;
    if (!user) {
      isNewUser = true;
      // create a username from email local part (ensure uniqueness by appending short id if needed)
      const local = email.split('@')[0].replace(/[^a-zA-Z0-9_\-\.]/g, '');
      let username = local;
      // ensure username unique
      let suffix = 0;
      while (await this.prisma.users.findUnique({ where: { username } })) {
        suffix += 1;
        username = `${local}${suffix}`;
      }

      // create user
      user = await this.prisma.users.create({
        data: {
          email,
          username,
          email_verified: true,
          // Don't set full_name here - user should complete personal-info during onboarding
          // full_name: name,
          profile_pic_url: picture,
          // leave password_hash null for social logins
        },
      });
    }

    // Generate refresh token and session similar to verify2FA flow
    const refreshToken = await this.tokenService.generateRefreshToken({
      sub: user.user_id,
      email: user.email,
      username: user.username,
    });

    const sessionId = await this.sessionService.createSession(
      user.user_id,
      refreshToken,
      ipAddress,
      deviceId,
    );

    const payloadForAccess = {
      sub: user.user_id,
      email: user.email,
      username: user.username,
      session_id: sessionId,
    } as TokenPayload;

    const accessToken = await this.tokenService.generateAccessToken(payloadForAccess);

    return {
      user: {
        user_id: user.user_id,
        email: user.email,
        username: user.username,
        email_verified: user.email_verified,
        kyc_status: user.kyc_status,
      },
      accessToken,
      refreshToken,
      sessionId,
    };
  }

  /**
   * Verify user's password
   * Used before sensitive operations like account deletion
   */
  async verifyPassword(userId: string, password: string) {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid password');
    }

    return {
      success: true,
      message: 'Password verified successfully',
    };
  }

  /**
   * Request 2FA code for account deletion
   * Generates and sends verification code to user's email
   */
  async requestDeleteAccountCode(userId: string) {
    // Get user
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Generate and send 2FA code for account deletion
    const code = await this.twoFactorService.generateCode(
      userId,
      'account_deletion',
    );
    await this.twoFactorService.sendCodeByEmail(user.email, code);

    return {
      message: 'Verification code sent to your email',
      email: user.email,
    };
  }

  /**
   * Complete account deletion with all related entities
   * Executes deletion in reverse dependency order (children → parent)
   * Uses database transaction for atomicity
   */
  async deleteAccount(
    userId: string,
    deleteAccountDto: DeleteAccountDto,
  ) {
    const { password, twoFactorCode } = deleteAccountDto;

    // ===== PHASE 0: PRE-DELETION SAFETY CHECKS =====

    // Step 1: Authenticate the user
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid password');
    }

    // Verify 2FA code
    const isValid = await this.twoFactorService.validateCode(
      userId,
      twoFactorCode,
      'account_deletion',
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    // Step 2: Check for active orders (orders → portfolio_id → portfolios.user_id)
    const activeOrdersCount = await this.prisma.orders.count({
      where: {
        portfolio: {
          user_id: userId,
        },
        status: {
          in: ['pending', 'partially_filled'],
        },
      },
    });

    if (activeOrdersCount > 0) {
      throw new BadRequestException(
        `Cannot delete account: You have ${activeOrdersCount} active or pending order(s). ` +
        `Please ensure all orders are completed, cancelled, or rejected before deleting your account.`,
      );
    }

    // Step 3: Check for open positions (portfolio_positions → portfolio_id → portfolios.user_id)
    const openPositionsCount = await this.prisma.portfolio_positions.count({
      where: {
        portfolio: {
          user_id: userId,
        },
        quantity: {
          not: 0,
        },
      },
    });

    if (openPositionsCount > 0) {
      throw new BadRequestException(
        `Cannot delete account: You have ${openPositionsCount} open position(s). ` +
        `Please close all positions before deleting your account.`,
      );
    }

    // Step 4: Check for active subscriptions
    const activeSubscriptionsCount = await this.prisma.user_subscriptions.count({
      where: {
        user_id: userId,
        status: 'active',
        expires_at: {
          gt: new Date(),
        },
      },
    });

    if (activeSubscriptionsCount > 0) {
      throw new BadRequestException(
        `Cannot delete account: You have ${activeSubscriptionsCount} active subscription(s). ` +
        `Please cancel your subscription(s) before deleting your account.`,
      );
    }

    // Step 5: Check for pending KYC (warn but allow)
    if (user.kyc_status === 'review' || user.kyc_status === 'pending') {
      console.warn(
        `[ACCOUNT_DELETION] User ${userId} (${user.email}) is deleting account with KYC status: ${user.kyc_status}`,
      );
    }

    // Step 6: Collect all cloud storage files for deletion BEFORE transaction
    const filesToDelete: string[] = [];

    // Collect profile picture
    if (user.profile_pic_url) {
      filesToDelete.push(user.profile_pic_url);
    }

    // Collect KYC documents
    const kycVerifications = await this.prisma.kyc_verifications.findMany({
      where: { user_id: userId },
      include: {
        documents: true,
        face_matches: true,
      },
    });

    for (const kyc of kycVerifications) {
      for (const doc of kyc.documents) {
        if (doc.storage_url) {
          filesToDelete.push(doc.storage_url);
        }
      }
      for (const faceMatch of kyc.face_matches) {
        if (faceMatch.photo_url) {
          filesToDelete.push(faceMatch.photo_url);
        }
      }
    }

    // ===== ALL SAFETY CHECKS PASSED - Proceed with deletion =====

    // Step 7: Use database transaction to delete all related entities
    // Deletion order: child entities → parent entities
    // Note: timeout set to 60 seconds (default 5s) to allow deletion of users with large amounts of data
    const deletionSummary = await this.prisma.$transaction(
      async (tx) => {
        const summary = {
        user_id: userId,
        deleted_at: new Date(),
        entities_deleted: {},
      };

      // ===== PHASE 1: DELETE TEMPORARY/EPHEMERAL DATA =====

      // Delete 2FA codes
      const twoFactorCodesDeleted = await tx.two_factor_codes.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['two_factor_codes'] =
        twoFactorCodesDeleted.count;

      // Revoke all sessions
      const sessionsDeleted = await tx.user_sessions.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['user_sessions'] = sessionsDeleted.count;

      // ===== PHASE 2: DELETE KYC AND DOCUMENTS =====

      // Get KYC verification IDs for deletion
      const kycVerificationIds = kycVerifications.map((k) => k.kyc_id);

      // Delete KYC face matches
      const faceMatchesDeleted = await tx.kyc_face_matches.deleteMany({
        where: { kyc_id: { in: kycVerificationIds } },
      });
      summary.entities_deleted['kyc_face_matches'] = faceMatchesDeleted.count;

      // Delete KYC documents
      const kycDocsDeleted = await tx.kyc_documents.deleteMany({
        where: { kyc_id: { in: kycVerificationIds } },
      });
      summary.entities_deleted['kyc_documents'] = kycDocsDeleted.count;

      // Delete KYC verifications
      const kycDeleted = await tx.kyc_verifications.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['kyc_verifications'] = kycDeleted.count;

      // ===== PHASE 3: DELETE EXCHANGE CONNECTIONS =====

      const exchangeConnectionsDeleted =
        await tx.user_exchange_connections.deleteMany({
          where: { user_id: userId },
        });
      summary.entities_deleted['user_exchange_connections'] =
        exchangeConnectionsDeleted.count;

      // ===== PHASE 4: DELETE PORTFOLIO-RELATED DATA =====

      // Get all portfolios
      const portfolios = await tx.portfolios.findMany({
        where: { user_id: userId },
        include: {
          orders: true,
          snapshots: true,
          positions: true,
          optimizationRuns: true,
          drawdownHistories: true,
        },
      });

      // Delete drawdown history
      const drawdownDeleted = await tx.drawdown_history.deleteMany({
        where: { portfolio_id: { in: portfolios.map((p) => p.portfolio_id) } },
      });
      summary.entities_deleted['drawdown_history'] = drawdownDeleted.count;

      // Delete optimization-related data
      const optimizations = await tx.optimization_runs.findMany({
        where: { user_id: userId },
      });

      // Delete rebalance suggestions
      const rebalanceDeleted = await tx.rebalance_suggestions.deleteMany({
        where: {
          optimization_id: {
            in: optimizations.map((o) => o.optimization_id),
          },
        },
      });
      summary.entities_deleted['rebalance_suggestions'] = rebalanceDeleted.count;

      // Delete optimization allocations
      const allocationsDeleted = await tx.optimization_allocations.deleteMany({
        where: {
          optimization_id: {
            in: optimizations.map((o) => o.optimization_id),
          },
        },
      });
      summary.entities_deleted['optimization_allocations'] =
        allocationsDeleted.count;

      // Delete optimization runs
      const optimizationDeleted = await tx.optimization_runs.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['optimization_runs'] = optimizationDeleted.count;

      // Delete portfolio snapshots
      const snapshotsDeleted = await tx.portfolio_snapshots.deleteMany({
        where: { portfolio_id: { in: portfolios.map((p) => p.portfolio_id) } },
      });
      summary.entities_deleted['portfolio_snapshots'] = snapshotsDeleted.count;

      // Delete order executions
      const orderIds = portfolios.flatMap((p) => p.orders.map((o) => o.order_id));
      const executionsDeleted = await tx.order_executions.deleteMany({
        where: { order_id: { in: orderIds } },
      });
      summary.entities_deleted['order_executions'] = executionsDeleted.count;

      // Delete orders
      const ordersDeleted = await tx.orders.deleteMany({
        where: { portfolio_id: { in: portfolios.map((p) => p.portfolio_id) } },
      });
      summary.entities_deleted['orders'] = ordersDeleted.count;

      // Delete portfolio positions
      const positionsDeleted = await tx.portfolio_positions.deleteMany({
        where: { portfolio_id: { in: portfolios.map((p) => p.portfolio_id) } },
      });
      summary.entities_deleted['portfolio_positions'] = positionsDeleted.count;

      // Delete portfolios
      const portfoliosDeleted = await tx.portfolios.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['portfolios'] = portfoliosDeleted.count;

      // ===== PHASE 5: DELETE STRATEGY/SIGNAL DATA =====

      // Get all strategies for this user
      const strategies = await tx.strategies.findMany({
        where: { user_id: userId },
      });

      const strategyIds = strategies.map((s) => s.strategy_id);

      // Get all execution jobs
      const executionJobs = await tx.strategy_execution_jobs.findMany({
        where: { strategy_id: { in: strategyIds } },
      });

      // Delete strategy execution jobs
      const jobsDeleted = await tx.strategy_execution_jobs.deleteMany({
        where: { strategy_id: { in: strategyIds } },
      });
      summary.entities_deleted['strategy_execution_jobs'] = jobsDeleted.count;

      // Get all signals for this user
      const signals = await tx.strategy_signals.findMany({
        where: { user_id: userId },
      });

      const signalIds = signals.map((s) => s.signal_id);

      // Delete auto-trade evaluations
      const evaluationsDeleted = await tx.auto_trade_evaluations.deleteMany({
        where: { signal_id: { in: signalIds } },
      });
      summary.entities_deleted['auto_trade_evaluations'] =
        evaluationsDeleted.count;

      // Delete signal explanations
      const explanationsDeleted = await tx.signal_explanations.deleteMany({
        where: { signal_id: { in: signalIds } },
      });
      summary.entities_deleted['signal_explanations'] = explanationsDeleted.count;

      // Delete signal details
      const detailsDeleted = await tx.signal_details.deleteMany({
        where: { signal_id: { in: signalIds } },
      });
      summary.entities_deleted['signal_details'] = detailsDeleted.count;

      // Delete strategy signals
      const signalsDeleted = await tx.strategy_signals.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['strategy_signals'] = signalsDeleted.count;

      // Delete strategy parameters
      const parametersDeleted = await tx.strategy_parameters.deleteMany({
        where: { strategy_id: { in: strategyIds } },
      });
      summary.entities_deleted['strategy_parameters'] = parametersDeleted.count;

      // Delete strategies (including cloned ones)
      const strategiesDeleted = await tx.strategies.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['strategies'] = strategiesDeleted.count;

      // ===== PHASE 6: DELETE SUBSCRIPTIONS =====

      const subscriptionsDeleted = await tx.user_subscriptions.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['user_subscriptions'] = subscriptionsDeleted.count;

      // ===== PHASE 7: DELETE USER SETTINGS =====

      const settingsDeleted = await tx.user_settings.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['user_settings'] = settingsDeleted.count;

      // ===== PHASE 8: DELETE RISK EVENTS =====

      const riskEventsDeleted = await tx.risk_events.deleteMany({
        where: { user_id: userId },
      });
      summary.entities_deleted['risk_events'] = riskEventsDeleted.count;

      // ===== PHASE 9: DELETE USER RECORD =====

      await tx.users.delete({
        where: { user_id: userId },
      });
      summary.entities_deleted['users'] = 1;

      return summary;
        },
        {
          timeout: 60000, // 60 seconds - allows deletion of users with large amounts of data
        },
      );

    // Step 8: Delete cloud storage files AFTER database transaction succeeds
    // This ensures files are only deleted if all database operations succeed
    let cloudFilesDeleted = 0;
    let cloudFilesFailed = 0;

    for (const fileUrl of filesToDelete) {
      try {
        await this.storageService.deleteFile(fileUrl);
        cloudFilesDeleted++;
      } catch (error) {
        cloudFilesFailed++;
        console.error(
          `[ACCOUNT_DELETION] Failed to delete cloud file: ${fileUrl}`,
          error,
        );
        // Continue deletion - don't fail entire operation
      }
    }

    // Log final deletion summary
    console.log(`[ACCOUNT_DELETION] Account deleted successfully`, {
      user_id: userId,
      email: user.email,
      username: user.username,
      kyc_status: user.kyc_status,
      reason: deleteAccountDto.reason || 'No reason provided',
      database_entities_deleted: deletionSummary.entities_deleted,
      cloud_files_deleted: cloudFilesDeleted,
      cloud_files_failed: cloudFilesFailed,
      deleted_at: deletionSummary.deleted_at,
    });

    return {
      message: 'Account deleted successfully',
      summary: {
        ...deletionSummary,
        cloud_storage: {
          files_deleted: cloudFilesDeleted,
          files_failed: cloudFilesFailed,
          total_files: filesToDelete.length,
        },
      },
    };
  }
}


