"use client";

import { CredentialRequest, IDKitRequestWidget, IDKitSessionWidget, type IDKitErrorCodes, type RpContext } from "@worldcoin/idkit";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, formatEther, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { challengeRewardsAbi, humanRegistryAbi } from "@/lib/chain/abi";
import { APPROVAL_TYPES } from "@/lib/chain/types";
import { enrollSignal } from "@/lib/world/identity";

type Config = {
  chainId: number;
  mode: "real" | "simulated";
  worldEnvironment: "production" | "staging";
  explorer: string | null;
  contracts: { HumanRegistry: Address; PermissionRegistry: Address; ValidationReceipts: Address; PenaltyLedger: Address };
  judge: Address | null;
  rewards: Address | null;
};
type Rewards = {
  points: number;
  threshold: number;
  cooldown: number;
  secondsUntilNextPoint: number;
  optedIn: boolean;
  claimed: boolean;
  optedInCount: number;
  deadline: number;
  poolWei: string;
  shareWei: string;
  contract: Address;
};

type Answer = { id: string; round: number; code: string; task: string; linesChanged: number; commitHash: Hex };
type Judged = { verdict: "right" | "wrong"; tokenId: string | null; txHash: Hex | null };
type Standing = {
  enrolled: boolean;
  level: number;
  status: "none" | "active" | "restricted" | "banned";
  tokens: number;
  restrictedSeconds: number;
  penalties: { tokenId: string; receiptId: string; mintedAt: number; txHash: Hex; lifted: boolean }[];
  receipts: { receiptId: string; txHash: Hex; createdAt: number; judged: Judged | null }[];
  rewards: Rewards | null;
};
type JudgeResult = Judged & {
  receiptId: string;
  salt: Hex;
  commitment: Hex;
  fingerprintMatches: boolean;
  alreadyJudged: boolean;
  reward: null | { awarded: boolean; note: string; txHash: Hex | null };
};
type Attestation = { humanId: Hex; sessionRef: Hex; credentialLevel: number; deadline: string; signature: Hex; humanRegistry: Address };
type Prepared = {
  approvalId: string;
  signal: string;
  sessionId: string | null;
  typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: Address }; message: Record<string, unknown> };
};

type Eth = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
const eth = () => (globalThis as unknown as { ethereum?: Eth }).ethereum;

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? json.error ?? `HTTP ${res.status}`);
  return json as T;
}

const short = (s: string, n = 6) => `${s.slice(0, n + 2)}…${s.slice(-4)}`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const LEVEL = { 1: "Orb (Proof of Human)", 2: "Selfie Check", 3: "SIMULATED (no World proof)" } as Record<number, string>;

const C = {
  green: "#1a7f37",
  red: "#cf222e",
  yellow: "#bf8700",
  grey: "#8c959f",
  card: { border: "1px solid #d0d7de", borderRadius: 10, padding: 16, background: "var(--background, #fff)" } as const,
};

function Btn(props: { color: string; disabled?: boolean; onClick: () => void; children: React.ReactNode; big?: boolean }) {
  return (
    <button
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        background: props.disabled ? C.grey : props.color,
        color: "#fff",
        border: 0,
        borderRadius: 8,
        padding: props.big ? "12px 22px" : "8px 14px",
        fontSize: props.big ? 17 : 14,
        fontWeight: 600,
        cursor: props.disabled ? "not-allowed" : "pointer",
        marginRight: 8,
      }}
    >
      {props.children}
    </button>
  );
}

export default function DemoApp({ config, appId }: { config: Config; appId: `app_${string}` }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastJudge, setLastJudge] = useState<JudgeResult | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [reason, setReason] = useState("");
  const [enrollRp, setEnrollRp] = useState<{ rp_context: RpContext; action?: string } | null>(null);
  const [sessionRp, setSessionRp] = useState<{ rp_context: RpContext } | null>(null);
  const [pendingEnroll, setPendingEnroll] = useState<{ enrollmentId: string; sessionSignal: string } | null>(null);
  const [approveRp, setApproveRp] = useState<{ rp_context: RpContext; prepared: Prepared; signature: Hex } | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  const link = (kind: "tx" | "address" | "token", v: string, label?: string, tokenId?: string) =>
    config.explorer ? (
      <a href={kind === "token" ? `${config.explorer}/token/${config.contracts.PenaltyLedger}?a=${tokenId}` : `${config.explorer}/${kind}/${v}`} target="_blank" rel="noreferrer">
        {label ?? short(v)} ↗
      </a>
    ) : (
      <code>{label ?? short(v)}</code>
    );

  const clients = () => {
    const provider = eth();
    if (!provider) throw new Error("MetaMask not found. Install it and reload.");
    return {
      wallet: createWalletClient({ chain: sepolia, transport: custom(provider) }),
      pub: createPublicClient({ chain: sepolia, transport: custom(provider) }),
    };
  };

  const refresh = useCallback(async (acc: Address | null = account) => {
    if (!acc) return;
    const s = await api<Standing>(`/api/demo/standing?account=${acc}`);
    setStanding(s);
    setCountdown(s.restrictedSeconds);
  }, [account]);

  // live countdown; re-read the chain when it ends (the restriction lifts by itself)
  useEffect(() => {
    if (tick.current) clearInterval(tick.current);
    if (countdown <= 0) return;
    tick.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          void refresh().catch(() => {});
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, [countdown > 0, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setBusy(null);
    }
  }

  const connect = () =>
    run("Connecting wallet…", async () => {
      const { wallet } = clients();
      const [acc] = await wallet.requestAddresses();
      try {
        await wallet.switchChain({ id: sepolia.id });
      } catch {
        await wallet.addChain({ chain: sepolia });
        await wallet.switchChain({ id: sepolia.id });
      }
      setAccount(acc);
      await refresh(acc);
    });

  /** The user's own wallet sends enrollAttested, then the admin grants the demo "validator" preset. */
  async function finishEnroll(a: Attestation) {
    const { wallet, pub } = clients();
    setBusy("Confirm the enrollment in MetaMask…");
    const hash = await wallet.writeContract({
      account: account!,
      chain: sepolia,
      address: a.humanRegistry,
      abi: humanRegistryAbi,
      functionName: "enrollAttested",
      args: [a.humanId, a.sessionRef, a.credentialLevel, BigInt(a.deadline), a.signature],
    });
    setBusy("Waiting for the enrollment on Sepolia…");
    await pub.waitForTransactionReceipt({ hash });
    setBusy("Granting validator permissions…");
    await api("/api/demo/onboard", { account });
    await refresh();
    setNotice("Enrolled ✓");
  }

  const enroll = () =>
    run("Enrolling…", async () => {
      if (config.mode === "simulated") {
        const r = await api<{ attestation: Attestation }>("/api/enroll/simulated", { account });
        await finishEnroll(r.attestation);
        return;
      }
      setEnrollRp(await api("/api/world/rp-context", { kind: "enroll" }));
    });

  const ask = () =>
    run("The AI is writing…", async () => {
      setLastJudge(null);
      setAnswer(await api<Answer>("/api/demo/ask", { account }));
    });

  const reject = () =>
    run("Asking again…", async () => {
      setAnswer(await api<Answer>("/api/demo/reject", { proposalId: answer!.id }));
    });

  async function completeApproval(prepared: Prepared, signature: Hex, result?: unknown) {
    setBusy("Recording the receipt on Sepolia…");
    const r = await api<{ receiptId: string; txHash: Hex }>("/api/approve/complete", { approvalId: prepared.approvalId, signature, ...(result ? { result } : {}) });
    setAnswer(null);
    await refresh();
    setNotice(`Receipt #${r.receiptId} recorded. No token minted. The judge is checking…`);
    await runJudge(r.receiptId);
  }

  const approve = () =>
    run("Preparing the approval…", async () => {
      const prepared = await api<Prepared>("/api/demo/prepare", { proposalId: answer!.id });
      const { wallet } = clients();
      setBusy("Sign the approval in MetaMask…");
      const m = prepared.typedData.message;
      const signature = await wallet.signTypedData({
        account: account!,
        domain: prepared.typedData.domain,
        types: APPROVAL_TYPES,
        primaryType: "HumanApproval",
        message: { ...m, nonce: BigInt(m.nonce as string), deadline: BigInt(m.deadline as string) } as never,
      });
      if (config.mode === "simulated") return completeApproval(prepared, signature);
      const rp = await api<{ rp_context: RpContext }>("/api/world/rp-context", { kind: "session" });
      setApproveRp({ ...rp, prepared, signature }); // World ID proof at this moment, then complete
    });

  async function runJudge(receiptId: string) {
    setBusy("The judge is revealing the verdict…");
    try {
      const j = await api<JudgeResult>("/api/demo/judge", { receiptId });
      setLastJudge(j);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  /** Prize actions are sent by the user's own wallet (ChallengeRewards.optIn / claim). */
  const rewardTx = (fn: "optIn" | "claim", label: string, done: string) =>
    run(label, async () => {
      const { wallet, pub } = clients();
      setBusy(`Confirm in MetaMask: ${fn}…`);
      const hash = await wallet.writeContract({ account: account!, chain: sepolia, address: config.rewards!, abi: challengeRewardsAbi, functionName: fn });
      setBusy("Waiting for Sepolia…");
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`${fn} reverted`);
      await refresh();
      setNotice(`${done} tx ${short(hash)}`);
    });

  const lift = () =>
    run("The judge is lifting the restriction…", async () => {
      const r = await api<{ txHash: Hex }>("/api/demo/lift", { account, reason });
      setReason("");
      await refresh();
      setNotice(`Restriction lifted by the judge (the token stays). tx ${short(r.txHash)}`);
    });

  const s = standing;
  const status = s?.status ?? "none";
  const canUse = !!account && s?.enrolled && status === "active" && !busy;

  return (
    <main style={{ maxWidth: 1200, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif", lineHeight: 1.45 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Human-in-the-loop accountability for AI code</h1>
        {config.mode === "simulated" && (
          <span style={{ background: "#fff8c5", border: `1px solid ${C.yellow}`, color: "#7d4e00", borderRadius: 20, padding: "2px 10px", fontSize: 13, fontWeight: 600 }}>
            World ID: simulated
          </span>
        )}
        <span style={{ fontSize: 13, color: "#57606a" }}>Sepolia · judge {config.judge ? link("address", config.judge) : "?"}</span>
      </header>

      {(busy || error || notice) && (
        <div style={{ ...C.card, marginBottom: 16, borderColor: error ? C.red : busy ? C.yellow : C.green }}>
          {busy && <span>⏳ {busy}</span>}
          {error && <span style={{ color: C.red }}>✗ {error}</span>}
          {notice && !busy && <span style={{ color: C.green }}>{notice}</span>}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr 1.1fr", gap: 16, alignItems: "start" }}>
        {/* ---------------------------------------------------------------- 1. Sign in */}
        <section style={C.card}>
          <h2 style={{ fontSize: 17, marginTop: 0 }}>1. Sign in</h2>
          {!account ? (
            <Btn color="#0969da" onClick={connect} disabled={!!busy}>Connect MetaMask</Btn>
          ) : (
            <p style={{ margin: "4px 0" }}>Wallet {link("address", account)}</p>
          )}
          {account && s && !s.enrolled && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: 14 }}>One human = one account. {config.mode === "simulated" ? "World ID is simulated in this demo." : "Prove you are human with World ID."}</p>
              <Btn color="#0969da" onClick={enroll} disabled={!!busy}>Enroll with World ID</Btn>
            </div>
          )}
          {s?.enrolled && (
            <p style={{ color: C.green, fontWeight: 600 }}>
              Enrolled ✓ <span style={{ fontWeight: 400, color: "#57606a", fontSize: 13 }}>credential: {LEVEL[s.level] ?? s.level}</span>
            </p>
          )}
        </section>

        {/* ---------------------------------------------------------------- 2. AI answer */}
        <section style={C.card}>
          <h2 style={{ fontSize: 17, marginTop: 0 }}>2. AI answer</h2>
          {status === "banned" ? (
            <p style={{ color: C.red, fontWeight: 700, fontSize: 18 }}>⛔ Repo access closed. Asking and approving are permanently disabled.</p>
          ) : (
            <>
              <Btn color="#0969da" onClick={ask} disabled={!canUse}>Ask the AI: write a hello world function</Btn>
              {status === "restricted" && <p style={{ color: C.yellow, fontWeight: 600 }}>Restricted: Ask and Approve are disabled for {mmss(countdown)}.</p>}
            </>
          )}
          {answer && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, color: "#57606a", marginBottom: 6 }}>
                Round {answer.round} · {answer.task} · commit {short(answer.commitHash, 8)}
              </div>
              <pre style={{ background: "#0d1117", color: "#e6edf3", padding: 14, borderRadius: 8, fontSize: 15, overflowX: "auto" }}>{answer.code}</pre>
              <Btn big color={C.green} onClick={approve} disabled={!canUse}>✓ Approve</Btn>
              <Btn big color={C.red} onClick={reject} disabled={!canUse}>✗ Reject</Btn>
              <div style={{ fontSize: 12, color: "#57606a", marginTop: 8 }}>
                Reject asks again (round +1, nothing on-chain). Approve records a receipt on-chain. The verdict is sealed in the receipt before you decide.
              </div>
            </div>
          )}
          {lastJudge && (
            <div style={{ marginTop: 14, padding: 12, borderRadius: 8, border: `2px solid ${lastJudge.verdict === "right" ? C.green : C.red}` }}>
              <div style={{ fontWeight: 700 }}>Judge on receipt #{lastJudge.receiptId}: the code was {lastJudge.verdict.toUpperCase()}</div>
              <div style={{ fontSize: 13 }}>
                Fingerprint matches ✓ <code>hash(code, &quot;{lastJudge.verdict}&quot;, salt {short(lastJudge.salt)}) = {short(lastJudge.commitment)}</code> = contextHash on-chain
              </div>
              {lastJudge.reward && (
                <div style={{ fontSize: 14, marginTop: 4, color: lastJudge.reward.awarded ? C.green : lastJudge.verdict === "wrong" ? C.red : "#57606a" }}>
                  ★ {lastJudge.reward.note} {lastJudge.reward.txHash && link("tx", lastJudge.reward.txHash, "tx")}
                </div>
              )}
              {lastJudge.verdict === "right" ? (
                <div style={{ color: C.green, fontWeight: 700, marginTop: 6 }}>Good decision ✓</div>
              ) : (
                <div style={{ color: C.red, fontWeight: 700, marginTop: 6 }}>
                  You approved wrong code: soulbound penalty token #{lastJudge.tokenId} minted{" "}
                  {lastJudge.txHash && link("tx", lastJudge.txHash, "mint tx")}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ---------------------------------------------------------------- Your standing */}
        <section style={C.card}>
          <h2 style={{ fontSize: 17, marginTop: 0 }}>Your standing</h2>
          {!s?.enrolled ? (
            <p style={{ color: C.grey }}>Connect and enroll to see your standing.</p>
          ) : (
            <>
              <div style={{ fontSize: 22, fontWeight: 700, color: status === "active" ? C.green : status === "restricted" ? C.yellow : C.red }}>
                {status === "active" ? "Active" : status === "restricted" ? `Restricted · ${mmss(countdown)}` : "Banned"}
              </div>
              <div style={{ margin: "6px 0 10px" }}>Penalty tokens: <b>{s.tokens} / 3</b></div>
              <ul style={{ paddingLeft: 18, margin: 0, fontSize: 14 }}>
                {s.penalties.map((p) => (
                  <li key={p.tokenId}>
                    Token {link("token", p.tokenId, `#${p.tokenId}`, p.tokenId)} · receipt #{p.receiptId} · {new Date(p.mintedAt * 1000).toLocaleTimeString()}
                    {p.lifted && <span style={{ color: "#57606a" }}> · restriction lifted</span>}
                  </li>
                ))}
              </ul>
              {status === "restricted" && (
                <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px dashed #d0d7de" }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Judge: lift restriction</div>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason (required)"
                    style={{ width: "100%", padding: 6, marginBottom: 6, boxSizing: "border-box" }}
                  />
                  <Btn color="#8250df" onClick={lift} disabled={!!busy || reason.trim().length < 3}>Lift restriction</Btn>
                  <div style={{ fontSize: 12, color: "#57606a", marginTop: 4 }}>The token stays: it is the permanent record.</div>
                </div>
              )}
              {status === "banned" && <p style={{ color: C.red, fontSize: 14 }}>3 tokens: banned for good. A ban can&apos;t be lifted, not even by the judge.</p>}
              {s.rewards && (
                <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid #d0d7de" }}>
                  <div style={{ fontWeight: 600 }}>
                    ★ Reward points: {s.rewards.points} / {s.rewards.threshold}
                    {s.rewards.optedIn && <span style={{ color: C.green }}> · in the prize ✓</span>}
                  </div>
                  <div style={{ fontSize: 13, color: "#57606a" }}>
                    +1 per correct approval, at most one per {mmss(s.rewards.cooldown)} (difficulty) · next point{" "}
                    {s.rewards.secondsUntilNextPoint > 0 ? `in ${mmss(s.rewards.secondsUntilNextPoint)}` : "available"}
                    <br />
                    Prize pool {formatEther(BigInt(s.rewards.poolWei))} ETH · {s.rewards.optedInCount} qualified · deadline{" "}
                    {new Date(s.rewards.deadline * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {" · "}
                    {config.explorer && link("address", s.rewards.contract, "contract")}
                  </div>
                  {!s.rewards.optedIn && Date.now() / 1000 <= s.rewards.deadline && (
                    <Btn color="#bf8700" disabled={!!busy || s.rewards.points < s.rewards.threshold} onClick={() => rewardTx("optIn", "Opting in…", "You are in the prize ✓")}>
                      Opt in to the prize
                    </Btn>
                  )}
                  {s.rewards.optedIn && !s.rewards.claimed && Date.now() / 1000 > s.rewards.deadline && (
                    <Btn color={C.green} disabled={!!busy} onClick={() => rewardTx("claim", "Claiming…", "Prize share claimed ✓")}>
                      Claim {formatEther(BigInt(s.rewards.shareWei))} ETH
                    </Btn>
                  )}
                  {s.rewards.claimed && <div style={{ color: C.green }}>Prize share claimed ✓</div>}
                  <div style={{ fontSize: 12, color: "#57606a", marginTop: 4 }}>
                    Points are soulbound. Approving wrong code slashes them all; once in the prize, your share is kept.
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* ---------------------------------------------------------------- Receipts */}
      <section style={{ ...C.card, marginTop: 16 }}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>Receipts</h2>
        {!s?.receipts.length ? (
          <p style={{ color: C.grey }}>No receipts yet. Approving an answer records one on Sepolia (no token at approval).</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#57606a" }}>
                <th>Receipt</th>
                <th>Recorded</th>
                <th>Transaction</th>
                <th>Judge</th>
              </tr>
            </thead>
            <tbody>
              {s.receipts.map((r) => (
                <tr key={r.receiptId} style={{ borderTop: "1px solid #eaeef2" }}>
                  <td>#{r.receiptId}</td>
                  <td>{new Date(r.createdAt * 1000).toLocaleTimeString()}</td>
                  <td>{link("tx", r.txHash)}</td>
                  <td>
                    {!r.judged ? (
                      <Btn color="#57606a" disabled={!!busy} onClick={() => run("Running the judge…", () => runJudge(r.receiptId))}>
                        Run judge
                      </Btn>
                    ) : r.judged.verdict === "right" ? (
                      <span style={{ color: C.green }}>Good decision ✓</span>
                    ) : (
                      <span style={{ color: C.red }}>
                        Wrong → token #{r.judged.tokenId} {r.judged.txHash && link("tx", r.judged.txHash, "mint")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ---------------------------------------------------------------- World ID widgets (real mode) */}
      {enrollRp?.action && account && (
        <IDKitRequestWidget
          open
          onOpenChange={(o) => !o && setEnrollRp(null)}
          app_id={appId}
          action={enrollRp.action}
          rp_context={enrollRp.rp_context}
          allow_legacy_proofs={false}
          environment={config.worldEnvironment}
          constraints={CredentialRequest("proof_of_human", { signal: enrollSignal(account) })}
          handleVerify={async (result) => {
            const r = await api<{ status: string; enrollmentId?: string; sessionSignal?: string; attestation?: Attestation }>("/api/enroll/start", { account, result });
            if (r.status === "attested" && r.attestation) await run("Enrolling…", () => finishEnroll(r.attestation!));
            else if (r.enrollmentId && r.sessionSignal) {
              setPendingEnroll({ enrollmentId: r.enrollmentId, sessionSignal: r.sessionSignal });
              setSessionRp(await api("/api/world/rp-context", { kind: "session" }));
            }
          }}
          onSuccess={() => setEnrollRp(null)}
          onError={(code: IDKitErrorCodes) => setError(`World ID: ${code}`)}
        />
      )}
      {sessionRp && pendingEnroll && (
        <IDKitSessionWidget
          open
          onOpenChange={(o) => !o && setSessionRp(null)}
          app_id={appId}
          rp_context={sessionRp.rp_context}
          environment={config.worldEnvironment}
          constraints={CredentialRequest("proof_of_human", { signal: pendingEnroll.sessionSignal })}
          handleVerify={async (result) => {
            const r = await api<{ attestation: Attestation }>("/api/enroll/complete", { enrollmentId: pendingEnroll.enrollmentId, result });
            await run("Enrolling…", () => finishEnroll(r.attestation));
          }}
          onSuccess={() => setSessionRp(null)}
          onError={(code: IDKitErrorCodes) => setError(`World ID: ${code}`)}
        />
      )}
      {approveRp && approveRp.prepared.sessionId && (
        <IDKitSessionWidget
          open
          onOpenChange={(o) => !o && setApproveRp(null)}
          app_id={appId}
          rp_context={approveRp.rp_context}
          environment={config.worldEnvironment}
          existing_session_id={approveRp.prepared.sessionId as `session_${string}`}
          constraints={CredentialRequest("proof_of_human", { signal: approveRp.prepared.signal })}
          handleVerify={async (result) => {
            await run("Recording…", () => completeApproval(approveRp.prepared, approveRp.signature, result));
          }}
          onSuccess={() => setApproveRp(null)}
          onError={(code: IDKitErrorCodes) => setError(`World ID: ${code}`)}
        />
      )}
    </main>
  );
}
