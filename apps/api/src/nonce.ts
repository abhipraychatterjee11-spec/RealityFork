import { normalizeNonce, normalizeWalletAddress } from "@realityfork/shared";

export interface NonceRepository {
  isUsed(signerAddress: string, nonce: string | bigint | number): boolean;
  consumeWith<T>(signerAddress: string, nonce: string | bigint | number, operation: () => T): T;
}

export interface PrismaNonceTransaction {
  /**
   * In one database transaction, insert a row protected by a unique
   * (signerAddress, nonce) constraint and run operation using that transaction.
   * Roll back the insert if operation fails.
   */
  consumeWith<T>(
    signerAddress: string,
    nonce: string,
    operation: (transaction: unknown) => Promise<T>
  ): Promise<T>;
}

export class NonceReplayError extends Error {
  readonly code = "NONCE_REPLAY";

  constructor() {
    super("Nonce has already been used by this signer");
  }
}

export class MemoryNonceRepository implements NonceRepository {
  private readonly used = new Set<string>();

  private key(signerAddress: string, nonce: string | bigint | number): string {
    return `${normalizeWalletAddress(signerAddress)}:${normalizeNonce(nonce).toString(10)}`;
  }

  isUsed(signerAddress: string, nonce: string | bigint | number): boolean {
    return this.used.has(this.key(signerAddress, nonce));
  }

  consumeWith<T>(signerAddress: string, nonce: string | bigint | number, operation: () => T): T {
    const key = this.key(signerAddress, nonce);
    if (this.used.has(key)) throw new NonceReplayError();
    this.used.add(key);
    try {
      return operation();
    } catch (error) {
      this.used.delete(key);
      throw error;
    }
  }
}
