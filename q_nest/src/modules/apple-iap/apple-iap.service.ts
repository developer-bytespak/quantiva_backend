import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  JWSTransactionDecodedPayload,
  JWSRenewalInfoDecodedPayload,
  ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';

/**
 * Result of resolving + verifying a single StoreKit transaction against the
 * App Store Server API. `environment` reflects where the transaction was found
 * (Production vs Sandbox), determined by the production-first fallback probe.
 */
export interface VerifiedAppleTransaction {
  transaction: JWSTransactionDecodedPayload;
  environment: Environment;
}

/**
 * Thin wrapper around Apple's App Store Server library:
 *  - signs ES256 JWTs and calls the App Store Server API (verify transactions)
 *  - verifies + decodes App Store Server Notification V2 signed payloads
 *
 * Production-first with Sandbox fallback so the same backend handles both the
 * live app and sandbox/TestFlight builds without per-request environment hints.
 *
 * If the APPLE_IAP_* env vars are not configured the service boots in a
 * disabled state (logs a warning) and throws a clear error only when an Apple
 * endpoint is actually hit — so a missing key never crashes app startup.
 */
@Injectable()
export class AppleIapService implements OnModuleInit {
  private readonly logger = new Logger(AppleIapService.name);

  private bundleId = '';
  private configured = false;

  // Per-environment API clients + signed-data verifiers.
  private prodClient?: AppStoreServerAPIClient;
  private sandboxClient?: AppStoreServerAPIClient;
  private prodVerifier?: SignedDataVerifier;
  private sandboxVerifier?: SignedDataVerifier;

  onModuleInit(): void {
    try {
      const keyId = process.env.APPLE_IAP_KEY_ID;
      const issuerId = process.env.APPLE_IAP_ISSUER_ID;
      const bundleId = process.env.APPLE_IAP_BUNDLE_ID;
      const rawKey = process.env.APPLE_IAP_PRIVATE_KEY;
      // appAppleId is the app's numeric Apple ID (App Store Connect → App Information).
      // The library REQUIRES it to build a Production verifier; omitted in sandbox.
      const appAppleIdRaw = process.env.APPLE_IAP_APP_APPLE_ID;
      const appAppleId =
        appAppleIdRaw && !Number.isNaN(Number(appAppleIdRaw)) ? Number(appAppleIdRaw) : undefined;

      if (!keyId || !issuerId || !bundleId || !rawKey) {
        this.logger.warn(
          'Apple IAP not configured (missing APPLE_IAP_KEY_ID / ISSUER_ID / BUNDLE_ID / PRIVATE_KEY). Apple endpoints will reject until set.',
        );
        return;
      }

      // Accept the .p8 either as a full PEM (with BEGIN/END) or as the bare
      // base64 body — normalise to a valid PEM for jsonwebtoken's ES256 signing.
      const signingKey = this.normalizePrivateKey(rawKey);
      this.bundleId = bundleId;

      // DER-encoded Apple root certificates bundled with the module.
      const rootCertificates = this.loadRootCertificates();

      // Online checks enable OCSP revocation + expiry validation (recommended).
      const enableOnlineChecks = process.env.APPLE_IAP_DISABLE_ONLINE_CHECKS !== 'true';

      // API clients don't need appAppleId.
      this.prodClient = new AppStoreServerAPIClient(
        signingKey,
        keyId,
        issuerId,
        bundleId,
        Environment.PRODUCTION,
      );
      this.sandboxClient = new AppStoreServerAPIClient(
        signingKey,
        keyId,
        issuerId,
        bundleId,
        Environment.SANDBOX,
      );

      // Sandbox verifier is always available (no appAppleId required).
      this.sandboxVerifier = new SignedDataVerifier(
        rootCertificates,
        enableOnlineChecks,
        Environment.SANDBOX,
        bundleId,
        undefined,
      );

      // The library throws if a Production verifier is built without appAppleId,
      // so only build it when we have one. Without it we degrade to sandbox-only
      // verification instead of crashing — production goes live once it's set.
      if (appAppleId !== undefined) {
        this.prodVerifier = new SignedDataVerifier(
          rootCertificates,
          enableOnlineChecks,
          Environment.PRODUCTION,
          bundleId,
          appAppleId,
        );
      } else {
        this.logger.warn(
          'APPLE_IAP_APP_APPLE_ID is not set — PRODUCTION verification is disabled (sandbox only). Set it before going live on the App Store.',
        );
      }

      this.configured = true;
      this.logger.log(
        `Apple IAP configured for bundle ${bundleId} (online checks: ${enableOnlineChecks}, production: ${!!this.prodVerifier}).`,
      );
    } catch (err: any) {
      // Never let a misconfiguration crash app startup — disable Apple instead.
      this.configured = false;
      this.logger.error(`Apple IAP initialization failed; Apple endpoints disabled: ${err?.message}`);
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new Error('Apple IAP is not configured on this server');
    }
  }

  /**
   * Normalise an App Store Connect private key into a valid PKCS#8 PEM.
   * Accepts a full PEM (with `\n`-escaped or real newlines) or just the bare
   * base64 body pasted without the BEGIN/END armour.
   */
  private normalizePrivateKey(raw: string): string {
    const key = raw.trim().replace(/\\n/g, '\n');
    if (key.includes('BEGIN')) {
      return key; // already a PEM block
    }
    const body = key.replace(/\s+/g, '');
    const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
    return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
  }

  private loadRootCertificates(): Buffer[] {
    const certDir = join(__dirname, 'certs');
    const files = [
      'AppleComputerRootCertificate.cer',
      'AppleIncRootCertificate.cer',
      'AppleRootCA-G2.cer',
      'AppleRootCA-G3.cer',
    ];
    const certs: Buffer[] = [];
    for (const file of files) {
      try {
        certs.push(readFileSync(join(certDir, file)));
      } catch (err: any) {
        this.logger.warn(`Could not load Apple root cert ${file}: ${err?.message}`);
      }
    }
    if (certs.length === 0) {
      throw new Error('No Apple root certificates available for signature verification');
    }
    return certs;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Transaction verification (App Store Server API)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Look up a transaction by id against the App Store Server API and return the
   * verified, decoded transaction payload. Tries Production first, then Sandbox.
   *
   * Throws if the transaction cannot be found/verified in either environment.
   */
  async verifyTransaction(transactionId: string): Promise<VerifiedAppleTransaction> {
    this.assertConfigured();

    // Production first (only if a production verifier is configured).
    if (this.prodVerifier) {
      try {
        const transaction = await this.fetchAndDecode(
          this.prodClient!,
          this.prodVerifier,
          transactionId,
        );
        return { transaction, environment: Environment.PRODUCTION };
      } catch (prodErr: any) {
        this.logger.debug(
          `Production transaction lookup failed for ${transactionId}: ${prodErr?.message}. Trying sandbox.`,
        );
      }
    }

    // Sandbox fallback.
    try {
      const transaction = await this.fetchAndDecode(
        this.sandboxClient!,
        this.sandboxVerifier!,
        transactionId,
      );
      return { transaction, environment: Environment.SANDBOX };
    } catch (sandboxErr: any) {
      throw new Error(
        `Unable to verify Apple transaction ${transactionId} in production or sandbox: ${sandboxErr?.message}`,
      );
    }
  }

  private async fetchAndDecode(
    client: AppStoreServerAPIClient,
    verifier: SignedDataVerifier,
    transactionId: string,
  ): Promise<JWSTransactionDecodedPayload> {
    const response = await client.getTransactionInfo(transactionId);
    const signed = response.signedTransactionInfo;
    if (!signed) {
      throw new Error('App Store Server API returned no signedTransactionInfo');
    }
    return verifier.verifyAndDecodeTransaction(signed);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Server-to-Server Notification V2 verification
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Verify + decode an App Store Server Notification V2 signedPayload. Tries the
   * Production verifier first; on any verification failure falls back to the
   * Sandbox verifier (notifications for both arrive at the same URL).
   */
  async verifyNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload> {
    this.assertConfigured();
    if (this.prodVerifier) {
      try {
        return await this.prodVerifier.verifyAndDecodeNotification(signedPayload);
      } catch (prodErr: any) {
        this.logger.debug(
          `Production notification verification failed: ${prodErr?.message}. Trying sandbox.`,
        );
      }
    }
    return this.sandboxVerifier!.verifyAndDecodeNotification(signedPayload);
  }

  /**
   * Verify + decode a signedTransactionInfo string (e.g. from a notification's
   * data payload). Tries production verifier then sandbox.
   */
  async decodeSignedTransaction(signed: string): Promise<JWSTransactionDecodedPayload> {
    this.assertConfigured();
    if (this.prodVerifier) {
      try {
        return await this.prodVerifier.verifyAndDecodeTransaction(signed);
      } catch {
        /* fall through to sandbox */
      }
    }
    return this.sandboxVerifier!.verifyAndDecodeTransaction(signed);
  }

  /**
   * Verify + decode a signedRenewalInfo string from a notification payload.
   */
  async decodeSignedRenewalInfo(signed: string): Promise<JWSRenewalInfoDecodedPayload> {
    this.assertConfigured();
    if (this.prodVerifier) {
      try {
        return await this.prodVerifier.verifyAndDecodeRenewalInfo(signed);
      } catch {
        /* fall through to sandbox */
      }
    }
    return this.sandboxVerifier!.verifyAndDecodeRenewalInfo(signed);
  }
}
