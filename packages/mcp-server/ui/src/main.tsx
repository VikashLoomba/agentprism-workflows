import { createRoot } from "react-dom/client";
import { RunMonitor } from "./RunMonitor.js";
import "./style.css";

createRoot(document.getElementById("root") as HTMLElement).render(<RunMonitor />);
