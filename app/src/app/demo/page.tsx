import type { Metadata } from "next";
import { demoPublicConfig } from "@/lib/server/demo";
import DemoApp from "./DemoApp";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "HITL: human accountability for AI code" };

/** Single-user demo (docs/DEMO_PLAN.md). Only public values reach the client. */
export default function Page() {
  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID ?? "";
  return <DemoApp config={demoPublicConfig()} appId={appId as `app_${string}`} />;
}
