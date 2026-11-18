import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import "./ui.css";
import "./cro.css";
import "./home.css";
import "./find.css";
import "./find-b.css";
import "./find-c.css";
import "./settings.css";
import "./settings-b.css";
import "./jobs.css";
import "./public.css";

createRoot(document.getElementById("root")!).render(<BrowserRouter><App /></BrowserRouter>);
