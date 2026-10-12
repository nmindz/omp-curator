import type { Integration } from "./types.ts";
import { vercelIntegration } from "./vercel/index.ts";

/** Built-in integrations. Add one by implementing {@link Integration} and listing it here. */
export const INTEGRATIONS: readonly Integration[] = [vercelIntegration];
