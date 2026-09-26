"use client";

import { CredentialRequest, IDKitRequestWidget, IDKitSessionWidget, type IDKitErrorCodes, type RpContext } from "@worldcoin/idkit";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, formatEther, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import NetworkBackground from "./NetworkBackground";
import { bountyAbi, humanRegistryAbi } from "@/lib/chain/abi";
import { APPROVAL_TYPES } from "@/lib/chain/types";
import { enrollSignal } from "@/lib/world/identity";

type Config = {
  chainId: number;
  mode: "real" | "simulated";
  worldEnvironment: "production" | "staging";
  explorer: string | null;
  contracts: { HumanRegistry: Address; PermissionRegistry: Address; ValidationReceipts: Address; PenaltyLedger: Address };
  judge: Address | null;
  bounty: Address | null;
};
type Rewards = {
  tokens: number;
  threshold: number;
  cooldown: number;
  secondsUntilNext: number;
  qualified: boolean;
  claimed: boolean;
  qualifiedCount: number;
  claimOpensAt: number;
  poolWei: string;
  shareWei: string;
  bounty: Address;
  token: Address;
  codeURI: string;
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
  token: TokenNote;
  slash: null | { txHash: Hex | null; note: string };
};
type TokenNote = null | { awarded: boolean; note: string; txHash: Hex | null };
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
  green: "#34d399",
  red: "#fb7185",
  yellow: "#fbbf24",
  grey: "#64748b",
};

/** Themed button (demo.css): the colour picks the variant; the glow follows the cursor. */
function Btn(props: { color: string; disabled?: boolean; onClick: () => void; children: React.ReactNode; big?: boolean }) {
  const variant =
    props.color === C.green ? "hx-approve" : props.color === C.red ? "hx-report" : props.color === C.grey ? "hx-skip" : props.color === "#bf8700" ? "hx-gold" : "";
  return (
    <button
      disabled={props.disabled}
      onClick={props.onClick}
      className={`hx-btn ${props.big ? "hx-lg" : "hx-sm"} ${variant}`}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
        e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
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
  const [tokenCountdown, setTokenCountdown] = useState(0);
  const [lastReview, setLastReview] = useState<{ kind: "Report" | "Approve"; note: string; txs: { label: string; hash: Hex }[] } | null>(null);
  const [enrollRp, setEnrollRp] = useState<{ rp_context: RpContext; action?: string } | null>(null);
  const [sessionRp, setSessionRp] = useState<{ rp_context: RpContext } | null>(null);
  const [pendingEnroll, setPendingEnroll] = useState<{ enrollmentId: string; sessionSignal: string } | null>(null);
  const [approveRp, setApproveRp] = useState<{ rp_context: RpContext; prepared: Prepared; signature: Hex } | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  // Follow MetaMask: switching accounts (or disconnecting) updates the page.
  useEffect(() => {
    const provider = eth() as (Eth & { on?(e: string, f: (a: unknown) => void): void; removeListener?(e: string, f: (a: unknown) => void): void }) | undefined;
    if (!provider?.on) return;
    const onAccounts = (accs: unknown) => {
      const next = (accs as Address[])[0] ?? null;
      setAccount(next);
      setAnswer(null);
      setLastJudge(null);
      setStanding(null);
      if (next)
        void api<Standing>(`/api/demo/standing?account=${next}`)
          .then((s) => {
            setStanding(s);
            setCountdown(s.restrictedSeconds);
          })
          .catch(() => {});
    };
    provider.on("accountsChanged", onAccounts);
    return () => provider.removeListener?.("accountsChanged", onAccounts);
  }, []);

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
    setTokenCountdown(s.rewards?.secondsUntilNext ?? 0);
  }, [account]);

  // next-token countdown (shared 30 s cooldown); re-read the chain when it ends
  useEffect(() => {
    if (tokenCountdown <= 0) return;
    const id = setTimeout(() => {
      if (tokenCountdown === 1) void refresh().catch(() => {});
      setTokenCountdown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearTimeout(id);
  }, [tokenCountdown, refresh]);

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

  /** Report: the wallet signs "not acceptable" (one authentication per sample), +1 token, next round. */
  const reject = () =>
    run("Reporting…", async () => {
      const { wallet } = clients();
      setBusy("Sign the report in MetaMask…");
      const signature = await wallet.signMessage({ account: account!, message: `HITL demo: I report code sample ${answer!.id} as not acceptable.` });
      setBusy("Recording your review…");
      const r = await api<Answer & { token: TokenNote }>("/api/demo/reject", { proposalId: answer!.id, signature });
      setAnswer(r);
      setLastJudge(null);
      setLastReview({ kind: "Report", note: r.token?.note ?? "Reported", txs: r.token?.txHash ? [{ label: "token tx", hash: r.token.txHash }] : [] });
      await refresh();
      if (r.token) setNotice(`Reported. ${r.token.note}`);
    });

  async function completeApproval(prepared: Prepared, signature: Hex, result?: unknown) {
    setBusy("Recording the receipt on Sepolia…");
    const r = await api<{ receiptId: string; txHash: Hex }>("/api/approve/complete", { approvalId: prepared.approvalId, signature, ...(result ? { result } : {}) });
    setLastReview({ kind: "Approve", note: `Receipt #${r.receiptId} recorded`, txs: [{ label: "receipt tx", hash: r.txHash }] });
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
      setLastReview((v) =>
        v && v.kind === "Approve"
          ? {
              ...v,
              txs: [
                ...v.txs,
                ...(j.token?.txHash ? [{ label: "token tx", hash: j.token.txHash }] : []),
                ...(j.slash?.txHash ? [{ label: "slash tx", hash: j.slash.txHash }] : []),
              ],
            }
          : v,
      );
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
      const hash = await wallet.writeContract({ account: account!, chain: sepolia, address: config.bounty!, abi: bountyAbi, functionName: fn });
      setBusy("Waiting for Sepolia…");
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`${fn} reverted`);
      await refresh();
      setNotice(`${done} tx ${short(hash)}`);
    });

  const s = standing;
  const status = s?.status ?? "none";
  const canUse = !!account && s?.enrolled && status === "active" && !busy;

  return (
    <main className="hitl-root" style={{ maxWidth: 1200, margin: "24px auto", padding: "0 16px", lineHeight: 1.45 }}>
      <NetworkBackground />
      <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Human-in-the-loop accountability for AI code</h1>
        {config.mode === "simulated" && (
          <span className="hx-badge">
            World ID: simulated
          </span>
        )}
        <span style={{ fontSize: 13, color: "var(--muted)" }}>Sepolia · judge {config.judge ? link("address", config.judge) : "?"}</span>
      </header>

      {(busy || error || notice) && (
        <div className="hx-glass" style={{ marginBottom: 16, borderColor: error ? C.red : busy ? C.yellow : C.green }}>
          {busy && <span>⏳ {busy}</span>}
          {error && <span style={{ color: C.red }}>✗ {error}</span>}
          {notice && !busy && <span style={{ color: C.green }}>{notice}</span>}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr 1.1fr", gap: 16, alignItems: "start" }}>
        {/* ---------------------------------------------------------------- 1. Sign in */}
        <section className="hx-glass">
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
              Enrolled ✓ <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 13 }}>credential: {LEVEL[s.level] ?? s.level}</span>
            </p>
          )}
        </section>

        {/* ---------------------------------------------------------------- 2. AI answer */}
        <section className="hx-glass">
          <h2 style={{ fontSize: 17, marginTop: 0 }}>2. AI answer</h2>
          {status === "banned" ? (
            <p style={{ color: C.red, fontWeight: 700, fontSize: 18 }}>⛔ Repo access closed. Asking and approving are permanently disabled.</p>
          ) : (
            <>
              <Btn color="#0969da" onClick={ask} disabled={!canUse}>Spawn code sample</Btn>
              {status === "restricted" && <p style={{ color: C.yellow, fontWeight: 600 }}>Restricted: Ask and Approve are disabled for {mmss(countdown)}.</p>}
            </>
          )}
          {answer && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 6 }}>
                Round {answer.round} · {answer.task} · commit {short(answer.commitHash, 8)}
              </div>
              <pre style={{ background: "#0d1117", color: "#e6edf3", padding: 14, borderRadius: 8, fontSize: 15, overflowX: "auto" }}>{answer.code}</pre>
              <Btn big color={C.green} onClick={approve} disabled={!canUse}>✓ Approve</Btn>
              <Btn big color={C.red} onClick={reject} disabled={!canUse}>✗ Report</Btn>
              <Btn big color={C.grey} onClick={ask} disabled={!canUse}>⏭ Skip</Btn>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                Approve or Report: each review earns +1 reward token (at most one per 30 s). Approving code that fails loses all your tokens. Skip does nothing. The verdict is sealed before you decide.
              </div>
            </div>
          )}
          {lastReview && (
            <div style={{ marginTop: 12, fontSize: 13, color: "var(--muted)" }}>
              Last submission: <b style={{ color: "#e6f1ff" }}>{lastReview.kind}</b> · {lastReview.note} · verify on Etherscan:{" "}
              {lastReview.txs.length === 0
                ? "no transaction (cooldown)"
                : lastReview.txs.map((t, i) => (
                    <span key={t.hash}>
                      {i > 0 && " · "}
                      {link("tx", t.hash, t.label)}
                    </span>
                  ))}
            </div>
          )}
          {lastJudge && (
            <div style={{ marginTop: 14, padding: 12, borderRadius: 8, border: `2px solid ${lastJudge.verdict === "right" ? C.green : C.red}` }}>
              <div style={{ fontWeight: 700 }}>Judge on receipt #{lastJudge.receiptId}: the code was {lastJudge.verdict.toUpperCase()}</div>
              <div style={{ fontSize: 13 }}>
                Fingerprint matches ✓ <code>hash(code, &quot;{lastJudge.verdict}&quot;, salt {short(lastJudge.salt)}) = {short(lastJudge.commitment)}</code> = contextHash on-chain
              </div>
              {lastJudge.token && (
                <div style={{ fontSize: 14, marginTop: 4, color: lastJudge.token.awarded ? C.green : "var(--muted)" }}>
                  ★ {lastJudge.token.note} {lastJudge.token.txHash && link("tx", lastJudge.token.txHash, "tx")}
                </div>
              )}
              {lastJudge.verdict === "right" ? (
                <div style={{ color: C.green, fontWeight: 700, marginTop: 6 }}>Good decision ✓</div>
              ) : (
                <div style={{ color: C.red, fontWeight: 700, marginTop: 6 }}>
                  You approved code that fails. {lastJudge.slash?.note ?? "Tokens slashed"}{" "}
                  {lastJudge.slash?.txHash && link("tx", lastJudge.slash.txHash, "slash tx")}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ---------------------------------------------------------------- Your standing */}
        <section className="hx-glass">
          <h2 style={{ fontSize: 17, marginTop: 0 }}>Your standing</h2>
          {!s?.enrolled ? (
            <p style={{ color: C.grey }}>Connect and enroll to see your standing.</p>
          ) : (
            <>
              {!s.rewards ? (
                <p style={{ color: C.grey }}>No bounty deployed.</p>
              ) : (
                <>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>
                    ★ {s.rewards.tokens} / {s.rewards.threshold} reward tokens
                  </div>
                  <div style={{ fontSize: 14, margin: "4px 0 8px", color: tokenCountdown > 0 ? C.yellow : C.green }}>
                    {tokenCountdown > 0 ? `Next token in ${mmss(tokenCountdown)}` : "Your next review can earn a token"}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>
                    Bounty {config.explorer && link("address", s.rewards.bounty, "contract")} · challenge code{" "}
                    <a href={s.rewards.codeURI} target="_blank" rel="noreferrer">
                      link ↗
                    </a>
                    <br />
                    Prize pool {formatEther(BigInt(s.rewards.poolWei))} ETH · {s.rewards.qualifiedCount} qualified
                    {s.rewards.qualified && <span style={{ color: C.green }}> · you qualified ✓</span>}
                  </div>
                  {!s.rewards.qualified && (
                    <Btn color="#bf8700" disabled={!!busy || s.rewards.tokens < s.rewards.threshold} onClick={() => rewardTx("optIn", "Qualifying…", "You qualified for the prize ✓")}>
                      Qualify for the prize ({s.rewards.threshold} tokens)
                    </Btn>
                  )}
                  {s.rewards.qualified && !s.rewards.claimed && (
                    <Btn color={C.green} disabled={!!busy} onClick={() => rewardTx("claim", "Claiming…", "Prize share claimed ✓")}>
                      Claim {formatEther(BigInt(s.rewards.shareWei))} ETH
                    </Btn>
                  )}
                  {s.rewards.claimed && <div style={{ color: C.green, marginTop: 6 }}>Prize share claimed ✓</div>}
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, paddingTop: 8, borderTop: "1px dashed rgba(34, 227, 255, 0.2)" }}>
                    <b style={{ color: "#cfe9ff" }}>Judges</b> hold JUDGE_ROLE on both contracts (the admin adds more with{" "}
                    <code>script/ManageJudge.s.sol</code>). On Etherscan:{" "}
                    {config.explorer && (
                      <>
                        <a href={`${config.explorer}/address/${s.rewards.bounty}#writeContract`} target="_blank" rel="noreferrer">
                          award (Bounty) ↗
                        </a>{" "}
                        ·{" "}
                        <a href={`${config.explorer}/address/${s.rewards.token}#writeContract`} target="_blank" rel="noreferrer">
                          slash (RewardToken) ↗
                        </a>{" "}
                        ·{" "}
                        <a href={`${config.explorer}/address/${s.rewards.bounty}#readContract`} target="_blank" rel="noreferrer">
                          read state ↗
                        </a>
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                    Tokens are soulbound. Every review earns one (at most one per {s.rewards.cooldown} s); approving code that fails loses them
                    all. Once qualified, your prize share is kept.
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>

      {/* ---------------------------------------------------------------- Receipts */}
      <section className="hx-glass" style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>Receipts</h2>
        {!s?.receipts.length ? (
          <p style={{ color: C.grey }}>No receipts yet. Approving a code sample records a receipt on Sepolia.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                <th>Receipt</th>
                <th>Recorded</th>
                <th>Transaction</th>
                <th>Judge</th>
              </tr>
            </thead>
            <tbody>
              {s.receipts.map((r) => (
                <tr key={r.receiptId} style={{ borderTop: "1px solid rgba(148, 163, 184, 0.15)" }}>
                  <td>#{r.receiptId}</td>
                  <td>{new Date(r.createdAt * 1000).toLocaleTimeString()}</td>
                  <td>{link("tx", r.txHash)}</td>
                  <td>
                    {!r.judged ? (
                      <Btn color="var(--muted)" disabled={!!busy} onClick={() => run("Running the judge…", () => runJudge(r.receiptId))}>
                        Run judge
                      </Btn>
                    ) : r.judged.verdict === "right" ? (
                      <span style={{ color: C.green }}>Good decision ✓</span>
                    ) : (
                      <span style={{ color: C.red }}>Code failed: tokens slashed</span>
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
