import { requestJson } from "./client";
import type { PairingConfirmResponse } from "./types";

export const pairingApi = {
  confirm: (code: string, agentId: string) =>
    requestJson<PairingConfirmResponse>(`/api/v1/pairing/${encodeURIComponent(code)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ agentId })
    })
};
