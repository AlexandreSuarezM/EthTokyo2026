import "server-only";
import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type Hash,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { validationReceiptsAbi } from "@/lib/chain/abi";

/**
 * The relayer pays gas for ValidationReceipts.validate: the validator is identified by their
 * EIP-712 signature, not by msg.sender, so anyone may submit it. It pays any fee too (fees are
 * paid by msg.sender).
 *
 * The relayer can NOT submit HumanRegistry.enrollAttested / rotateKeyAttested: those enroll
 * msg.sender, so the human's own wallet must send them (with the attester's signature).
 */

export type ValidateArgs = ContractFunctionArgs<typeof validationReceiptsAbi, "nonpayable", "validate">;

export class RelayError extends Error {
  constructor(
    readonly code: "reverted" | "failed",
    /** Custom error name decoded from the revert (e.g. "Expired", "Banned"), when available. */
    readonly errorName?: string,
    readonly txHash?: Hash,
  ) {
    super(errorName ? `${code}: ${errorName}` : code);
    this.name = "RelayError";
  }
}

function revertName(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason;
  }
  return undefined;
}

export function createRelayer(opts: {
  wallet: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  receipts: Address;
}) {
  const { wallet, publicClient, receipts } = opts;

  return {
    address: wallet.account.address,

    /**
     * Simulates first: a call that would revert never becomes a transaction (fail closed).
     * Returns the new receipt id from the Validated event.
     */
    async submitValidate(args: ValidateArgs): Promise<{ txHash: Hash; receiptId: bigint }> {
      let request;
      try {
        ({ request } = await publicClient.simulateContract({
          account: wallet.account,
          address: receipts,
          abi: validationReceiptsAbi,
          functionName: "validate",
          args,
        }));
      } catch (err) {
        throw new RelayError("reverted", revertName(err));
      }

      const txHash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new RelayError("failed", undefined, txHash);

      const [event] = parseEventLogs({ abi: validationReceiptsAbi, eventName: "Validated", logs: receipt.logs });
      if (!event) throw new RelayError("failed", "NoValidatedEvent", txHash);
      return { txHash, receiptId: event.args.id };
    },
  };
}

export type Relayer = ReturnType<typeof createRelayer>;
