import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "@bbacigalupo/address-input/styles.css";
import "@bbacigalupo/address-batch/styles.css";
import "./demo.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
