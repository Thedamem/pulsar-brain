import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setToken } from "./api";
import { consumeUrlToken } from "./auth";
import { ToastProvider } from "./components/ui";
import "./styles.css";

const urlToken = consumeUrlToken();
if (urlToken) setToken(urlToken);

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root is missing");

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
