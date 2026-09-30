import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { ScrollText } from "./memory-prototype-icons.js";
import { CuHistoryPanel } from "./cu-history-panel.js";

/** Windows view of Agent CU evidence, separate from macOS human activity recording. */
export function AgentCuHistorySubPage(props: { client: MemmyAgentClient | null }) {
  const { t } = useTranslation();
  return <section className="memory-panel ch">
    <header className="memory-panel__header">
      <div className="memory-panel__header-main">
        <h3 className="memory-panel__title">
          <ScrollText size={18} className="text-text-ink/60" />
          {t("memory.nav.agentCuHistory")}
        </h3>
      </div>
    </header>
    <CuHistoryPanel client={props.client} standalone />
  </section>;
}
