import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Minimal ABI — only the functions we call from the backend
const QHQ_ABI = [
  'function setMerkleRoot(bytes32 _merkleRoot) external',
  'function balanceOf(address account) view returns (uint256)',
  'function claimed(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function merkleRoot() view returns (bytes32)',
  'function treasury() view returns (address)',
  'function verifyProof(address user, uint256 cumulativeAmount, bytes32[] proof) view returns (bool)',
  'event MerkleRootUpdated(bytes32 indexed newRoot, uint256 timestamp)',
];

@Injectable()
export class QhqTokenChainService implements OnModuleInit {
  private readonly logger = new Logger(QhqTokenChainService.name);
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private contract: ethers.Contract;
  private isReady = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    try {
      await this.initializeChainConnection();
    } catch (err) {
      // Non-fatal: chain service may be unavailable in local dev
      this.logger.warn(`Chain service init failed (non-fatal): ${err.message}`);
    }
  }

  private async initializeChainConnection() {
    const rpcUrl = this.configService.get<string>('BASE_RPC_URL') || 'https://mainnet.base.org';
    const contractAddress = this.configService.get<string>('QHQ_CONTRACT_ADDRESS');
    const walletPassword = this.configService.get<string>('QHQ_WALLET_PASSWORD');
    const keystoreInline = this.configService.get<string>('TREASURY_KEYSTORE');
    const keystorePath = this.configService.get<string>('QHQ_KEYSTORE_PATH') ||
      path.join(process.cwd(), 'treasury-wallet.json');

    if (!contractAddress) {
      this.logger.warn('QHQ_CONTRACT_ADDRESS not set — chain features disabled');
      return;
    }

    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    // Load encrypted keystore — prefer inline env var (Render), fall back to file path (local)
    let encryptedJson: string | null = null;
    if (keystoreInline) {
      encryptedJson = keystoreInline;
    } else if (fs.existsSync(keystorePath)) {
      encryptedJson = fs.readFileSync(keystorePath, 'utf8');
    }

    if (encryptedJson && walletPassword) {
      this.signer = await ethers.Wallet.fromEncryptedJson(encryptedJson, walletPassword);
      this.signer = this.signer.connect(this.provider) as ethers.Wallet;
      this.logger.log(`Treasury wallet loaded: ${this.signer.address}`);
    } else {
      this.logger.warn('No keystore found — read-only chain mode');
    }

    this.contract = new ethers.Contract(
      contractAddress,
      QHQ_ABI,
      this.signer || this.provider,
    );

    this.isReady = true;
    this.logger.log(`QHQ chain service ready. Contract: ${contractAddress}`);
  }

  /**
   * Update the on-chain Merkle root.
   * Called weekly by the BullMQ cron job after recalculating all user allocations.
   */
  async setMerkleRoot(merkleRoot: string): Promise<string> {
    this.ensureReady();
    const tx = await this.contract.setMerkleRoot(merkleRoot);
    const receipt = await tx.wait();
    this.logger.log(`Merkle root updated on-chain. TX: ${receipt.hash}`);
    return receipt.hash as string;
  }

  /**
   * Get on-chain QHQ balance of a wallet address.
   */
  async getOnChainBalance(walletAddress: string): Promise<string> {
    this.ensureReady();
    const balance: bigint = await this.contract.balanceOf(walletAddress);
    return ethers.formatEther(balance);
  }

  /**
   * Get total QHQ ever claimed by a wallet address (high-water mark).
   */
  async getTotalClaimed(walletAddress: string): Promise<string> {
    this.ensureReady();
    const amount: bigint = await this.contract.claimed(walletAddress);
    return ethers.formatEther(amount);
  }

  /**
   * Get current on-chain Merkle root.
   */
  async getCurrentMerkleRoot(): Promise<string> {
    this.ensureReady();
    return await this.contract.merkleRoot();
  }

  /**
   * Get current on-chain total supply.
   */
  async getTotalSupply(): Promise<string> {
    this.ensureReady();
    const supply: bigint = await this.contract.totalSupply();
    return ethers.formatEther(supply);
  }

  /**
   * Verify a Merkle proof on-chain (read-only check).
   */
  async verifyProofOnChain(
    walletAddress: string,
    cumulativeAmountEther: string,
    proof: string[],
  ): Promise<boolean> {
    this.ensureReady();
    const amountWei = ethers.parseEther(cumulativeAmountEther);
    return await this.contract.verifyProof(walletAddress, amountWei, proof);
  }

  get ready(): boolean {
    return this.isReady;
  }

  private ensureReady() {
    if (!this.isReady) {
      throw new Error('QHQ chain service not initialized. Check contract address and RPC config.');
    }
  }
}
