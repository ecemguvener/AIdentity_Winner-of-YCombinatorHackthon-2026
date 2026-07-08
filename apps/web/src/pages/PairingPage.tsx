import { CheckCircle2, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { pairingApi } from "../api/pairing";
import type { AgentListItem } from "../api/types";
import type { ToastNotificationInput } from "../components/ToastNotifications";
import { Brand, dashboardPath, getErrorMessage } from "../shared";

export function PairingPage({
  agents,
  search,
  onClose,
  onNotify
}: {
  agents: AgentListItem[];
  search: string;
  onClose: () => void;
  onNotify: (notification: ToastNotificationInput) => void;
}) {
  const queryCode = useMemo(() => new URLSearchParams(search).get("code") ?? "", [search]);
  const [code, setCode] = useState(queryCode);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState("");
  const [confirmedPrefix, setConfirmedPrefix] = useState<string | null>(null);

  async function confirmPairing() {
    setIsConfirming(true);
    setError("");
    try {
      const response = await pairingApi.confirm(code.trim(), agentId);
      setConfirmedPrefix(response.tokenPrefix);
      onNotify({ title: "Runtime paired" });
    } catch (confirmError) {
      setError(getErrorMessage(confirmError, "Could not pair runtime"));
    } finally {
      setIsConfirming(false);
    }
  }

  return (
    <main className="pairing-page" aria-labelledby="pairingTitle">
      <section className="pairing-page__panel">
        <Brand className="pairing-page__brand" />
        <header>
          <h1 id="pairingTitle">Pair runtime</h1>
          <p>Approve the code from `npx @barkan/mcp --pair` and choose the agent identity this runtime can use.</p>
        </header>

        {confirmedPrefix ? (
          <div className="pairing-page__success" role="status">
            <CheckCircle2 size={22} aria-hidden="true" />
            <div>
              <strong>Runtime paired</strong>
              <span>Token {confirmedPrefix}... was created.</span>
            </div>
          </div>
        ) : (
          <div className="pairing-page__form">
            <label>
              <span>Pairing code</span>
              <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="XXXX-XXXX" />
            </label>
            <label>
              <span>Agent identity</span>
              <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>
            {error ? <p className="field-error" role="alert">{error}</p> : null}
            <button type="button" disabled={!code.trim() || !agentId || isConfirming} onClick={() => void confirmPairing()}>
              {isConfirming ? <Loader2 size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
              <span>Confirm pairing</span>
            </button>
          </div>
        )}

        <button className="pairing-page__secondary" type="button" onClick={onClose}>
          Back to agents
        </button>
      </section>
    </main>
  );
}
