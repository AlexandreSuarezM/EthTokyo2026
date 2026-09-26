"use client";

import { CredentialRequest, IDKitRequestWidget, IDKitSessionWidget, type IDKitErrorCodes, type RpContext } from "@worldcoin/idkit";
import { useState } from "react";
import type { DevResult } from "@/lib/dev/enroll";
import { enrollSignal } from "@/lib/world/identity";

type Props = { appId: `app_${string}`; environment: "production" | "staging"; account: `0x${string}` };
type Rp = { rp_context: RpContext; action?: string };
type Failure = { source: string; error: string; message?: string; worldCode?: string | null };

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}

export default function DevEnroll({ appId, environment, account }: Props) {
  const [enrollRp, setEnrollRp] = useState<Rp | null>(null);
  const [sessionRp, setSessionRp] = useState<Rp | null>(null);
  const [pending, setPending] = useState<Extract<DevResult, { status: "pending" }> | null>(null);
  const [done, setDone] = useState<Extract<DevResult, { status: "attested" }> | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  function finish(r: Extract<DevResult, { status: "attested" }>) {
    setDone(r);
    if (startedAt) setElapsed(Math.round((Date.now() - startedAt) / 1000));
  }

  async function rpContext(kind: "enroll" | "session"): Promise<Rp | null> {
    const res = await fetch("/api/world/rp-context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) });
    if (!res.ok) {
      setFailure({ source: "rp-context", error: `HTTP ${res.status}` });
      return null;
    }
    return (await res.json()) as Rp;
  }

  /** Our server's answer; throwing tells the widget the host app refused the proof. */
  function check(r: DevResult) {
    if (!r.ok) {
      setFailure({ source: "our server", error: r.error, message: r.message, worldCode: r.worldCode });
      throw new Error(r.error);
    }
  }

  const onIdkitError = (source: string) => (code: IDKitErrorCodes) =>
    setFailure((f) => f ?? { source: `World App / IDKit (${source})`, error: code });

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 22 }}>Dev: World ID enrollment smoke test</h1>
      <p style={{ fontSize: 14, opacity: 0.8 }}>
        Real World verify API, environment <b>{environment}</b>. Stops after the attester signature (no contracts, no transaction).
        Throwaway wallet: <code>{account}</code>
      </p>

      <ol style={{ paddingLeft: 20 }}>
        <li>
          <button
            disabled={!!pending || !!done}
            onClick={async () => {
              setFailure(null);
              setStartedAt((t) => t ?? Date.now());
              setEnrollRp(await rpContext("enroll"));
            }}
          >
            1. Prove you are human (uniqueness proof, action &quot;hitl-enroll&quot;)
          </button>
          {pending && <span> ✓ verified by World</span>}
        </li>
        <li style={{ marginTop: 12 }}>
          <button
            disabled={!pending || !!done}
            onClick={async () => {
              setFailure(null);
              setSessionRp(await rpContext("session"));
            }}
          >
            2. Create your World ID session
          </button>
        </li>
      </ol>

      {enrollRp && enrollRp.action && (
        <IDKitRequestWidget
          open={!!enrollRp}
          onOpenChange={(open) => !open && setEnrollRp(null)}
          app_id={appId}
          action={enrollRp.action}
          rp_context={enrollRp.rp_context}
          allow_legacy_proofs={false}
          environment={environment}
          // World ID 4.0 only. The proofOfHuman() preset adds a legacy (3.0) Orb fallback, and a 3.0
          // nullifier differs from the 4.0 one for the same person: one protocol version per action.
          constraints={CredentialRequest("proof_of_human", { signal: enrollSignal(account) })}
          handleVerify={async (result) => {
            const r = await post<DevResult>("/api/dev/enroll/start", { account, result });
            check(r);
            if (r.ok && r.status === "pending") setPending(r);
            if (r.ok && r.status === "attested") finish(r);
          }}
          onSuccess={() => setEnrollRp(null)}
          onError={onIdkitError("uniqueness proof")}
        />
      )}

      {sessionRp && pending && (
        <IDKitSessionWidget
          open={!!sessionRp}
          onOpenChange={(open) => !open && setSessionRp(null)}
          app_id={appId}
          rp_context={sessionRp.rp_context}
          environment={environment}
          constraints={CredentialRequest("proof_of_human", { signal: pending.sessionSignal })}
          handleVerify={async (result) => {
            const r = await post<DevResult>("/api/dev/enroll/complete", { enrollmentId: pending.enrollmentId, result });
            check(r);
            if (r.ok && r.status === "attested") finish(r);
          }}
          onSuccess={() => setSessionRp(null)}
          onError={onIdkitError("session")}
        />
      )}

      {done && (
        <section style={{ marginTop: 24, padding: 16, border: "2px solid #1a7f37", borderRadius: 8 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>✓ Success: verified by World, attester signed</h2>
          <p style={{ margin: "8px 0 0" }}>
            Credential level: <b>{done.credentialLevel === 1 ? "1 (Proof of Human / Orb)" : "2 (Selfie Check)"}</b>
            <br />
            session_id: <code>{done.sessionIdPrefix}</code>
            {elapsed !== null && (
              <>
                <br />
                Time from first click: {elapsed} s
              </>
            )}
          </p>
        </section>
      )}

      {failure && (
        <section style={{ marginTop: 24, padding: 16, border: "2px solid #cf222e", borderRadius: 8 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>✗ Failed ({failure.source})</h2>
          <p style={{ margin: "8px 0 0", fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
            error: {failure.error}
            {failure.message && `\nmessage: ${failure.message}`}
            {`\nworld: ${failure.worldCode ?? "(none)"}`}
          </p>
        </section>
      )}
    </main>
  );
}
