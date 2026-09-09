import { createRoot } from "react-dom/client";
import { useState } from "react";
import { RunMonitor } from "./RunMonitor.js";
import { MockHost, MockRunStore } from "./mock-host.js";
import "./style.css";

const store = new MockRunStore();
store.create("run-a");
store.create("run-b");
store.create("run-other-project", "project-two");
const hosts = [new MockHost(store)];

function Preview() {
  const [panels, setPanels] = useState([{ id: 0, host: hosts[0]! }]);
  const [mode, setMode] = useState("retained");
  const [selected, setSelected] = useState("run-a");
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((value) => value + 1);
  const open = (runId: string, reuse = mode === "reused") => {
    if (reuse && hosts[0]) hosts[0].input(runId);
    else {
      const host = new MockHost(store, runId);
      hosts.push(host);
      setPanels((current) => [...current, { id: hosts.length - 1, host }]);
    }
    refresh();
  };
  Object.assign(window, {
    monitorHarness: {
      store,
      hosts,
      open,
      refresh,
      unmount: (index: number) =>
        setPanels((current) => current.filter((panel) => panel.id !== index)),
      reopen: (index: number) => {
        const host = new MockHost(store, hosts[index]!.runId);
        hosts[index] = host;
        setPanels((current) => [
          ...current.filter((panel) => panel.id !== index),
          { id: index, host },
        ]);
      },
    },
  });
  return (
    <>
      <header className="harness-controls">
        <strong>Production monitor · mock host</strong>
        <select
          aria-label="Panel behavior"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="retained">Retain independent panels</option>
          <option value="reused">Reuse first panel</option>
        </select>
        <select
          aria-label="Scenario run"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option>run-a</option>
          <option>run-b</option>
        </select>
        <button onClick={() => open(selected)}>Open monitor</button>
        {(
          [
            "running",
            "setup",
            "permission",
            "checkpoint",
            "completed",
            "failed",
          ] as const
        ).map((scenario) => (
          <button
            key={scenario}
            onClick={() => {
              store.scenario(selected, scenario);
              refresh();
            }}
          >
            {scenario}
          </button>
        ))}
        <button
          onClick={() => hosts[0]!.hostContext({ displayMode: "inline" })}
        >
          Host exit fullscreen
        </button>
        <button onClick={() => void hosts[0]!.teardown()}>
          Teardown first panel
        </button>
      </header>
      <div className="harness-panels">
        {panels.map(({ id, host }) => (
          <section
            className="harness-panel"
            key={`${id}:${host.closed}`}
            data-panel={id}
          >
            <RunMonitor app={host.asApp()} />
          </section>
        ))}
      </div>
      <details className="harness-log">
        <summary>Outgoing calls and communication · revision {version}</summary>
        <button onClick={refresh}>Refresh log</button>
        <pre>
          {JSON.stringify(
            hosts.map((host) => ({
              runId: host.runId,
              calls: host.calls,
              contexts: host.contexts,
              messages: host.messages,
            })),
            null,
            2,
          )}
        </pre>
      </details>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
