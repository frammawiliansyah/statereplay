/**
 * StateReplay — cross-platform transfer (CEX → Network → DEX), abbreviated.
 *
 * Run it twice to see crash-resume:  npx tsx examples/cross-platform-transfer.ts
 *
 * The side-effect functions are mocked — there are no real exchange/chain calls.
 * Each step persists PROCESSING before its side-effect and SUCCESS/FAILED after,
 * so a crash resumes at the correct step instead of re-withdrawing funds.
 * Encryption is on, so the on-disk log is ciphertext.
 */
import { type StateReplay, createStateReplay } from "../src/index.js";

interface TransferData {
  amount?: number;
  destinationAddress?: string;
  txHash?: string;
}

// --- mocked side effects (stand-ins for a real ./automation module) ---------
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function executeCexWithdrawal(amount: number, to: string): Promise<string> {
  await delay(40);
  return `0x${(amount + to.length).toString(16)}cexwithdrawal`;
}
async function waitForNetworkConfirmation(txHash: string): Promise<void> {
  await delay(40);
  if (!txHash) {
    throw new Error("missing txHash");
  }
}
async function executeDexSwap(amount: number): Promise<void> {
  await delay(40);
  if (amount <= 0) {
    throw new Error("amount must be positive");
  }
}

async function runTransfer(
  replay: StateReplay<TransferData>,
  transferId: string,
  amount: number,
  destinationAddress: string,
): Promise<void> {
  const requireState = () => {
    const s = replay.getState(transferId);
    if (!s) {
      throw new Error(`no state for ${transferId}`);
    }
    return s;
  };

  let state = replay.getState(transferId);
  if (state?.step === "COMPLETED_ALL") {
    console.log(`${transferId} already completed on a previous run — nothing to do.`);
    return;
  }
  if (state) {
    console.log(`Resuming ${transferId} from step=${state.step} status=${state.status}`);
  }

  // Step 1: CEX withdrawal
  if (!state || state.step === "INIT") {
    await replay.setState(transferId, {
      step: "CEX_WITHDRAWAL",
      status: "PROCESSING",
      data: { amount, destinationAddress },
    });
    try {
      const txHash = await executeCexWithdrawal(amount, destinationAddress);
      await replay.setState(transferId, {
        step: "CEX_WITHDRAWAL",
        status: "SUCCESS",
        data: { txHash },
      });
    } catch (err) {
      await replay.setState(transferId, {
        step: "CEX_WITHDRAWAL",
        status: "FAILED",
        error: String(err),
      });
      throw err;
    }
  }

  state = requireState();

  // Step 2: Network confirmation — a safe resume point. `data` fields are optional,
  // so narrow with a guard (no non-null assertions needed).
  if (state.step === "CEX_WITHDRAWAL" && state.status === "SUCCESS") {
    const txHash = state.data?.txHash;
    if (!txHash) {
      throw new Error("CEX_WITHDRAWAL succeeded without a txHash");
    }
    await replay.setState(transferId, { step: "NETWORK_CONFIRMATION", status: "PROCESSING" });
    await waitForNetworkConfirmation(txHash);
    await replay.setState(transferId, { step: "NETWORK_CONFIRMATION", status: "SUCCESS" });
  }

  state = requireState();

  // Step 3: DEX swap
  if (state.step === "NETWORK_CONFIRMATION" && state.status === "SUCCESS") {
    await replay.setState(transferId, { step: "DEX_EXECUTION", status: "PROCESSING" });
    await executeDexSwap(amount);
    await replay.setState(transferId, { step: "COMPLETED_ALL", status: "COMPLETED" });
  }
}

async function main(): Promise<void> {
  const replay = await createStateReplay<TransferData>({
    storagePath: "./.transfer_logs",
    encrypt: true,
    secretKey: process.env.STATEREPLAY_SECRET ?? "demo-secret-not-for-production",
    // durability: "fsync" and lock: true are the defaults — exactly what a financial flow needs.
  });

  await runTransfer(replay, "transfer-001", 250, "0xDEADBEEFdestination");

  console.log("Final state:", replay.getState("transfer-001"));
  await replay.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
