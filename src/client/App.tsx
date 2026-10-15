import { Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import NewSearch from "./pages/NewSearch";
import SearchDetail from "./pages/SearchDetail";
import LeadDetail from "./pages/LeadDetail";
import AllLeads from "./pages/AllLeads";
import Settings from "./pages/Settings";
import Report from "./pages/Report";
import Radar from "./pages/Radar";
import Promising from "./pages/Promising";
import Import from "./pages/Import";
import Today from "./pages/Today";
import Shell, { Legacy } from "./components/Shell";

// Routes are unchanged. Redesigned pages (All leads, a lead) draw their own header inside the panel; the rest are wrapped in `Legacy` until their slice lands.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/r/*" element={<Report />} />
      <Route path="*" element={
        <Shell>
          <Routes>
            <Route path="/" element={<Legacy><NewSearch /></Legacy>} />
            <Route path="/searches/:id" element={<Legacy><SearchDetail /></Legacy>} />
            <Route path="/today" element={<Legacy><Today /></Legacy>} />
            <Route path="/leads" element={<AllLeads />} />
            <Route path="/leads/:id" element={<LeadDetail />} />
            <Route path="/promising" element={<Legacy><Promising /></Legacy>} />
            <Route path="/import" element={<Legacy><Import /></Legacy>} />
            <Route path="/radar" element={<Legacy><Radar /></Legacy>} />
            <Route path="/settings" element={<Legacy><Settings /></Legacy>} />
          </Routes>
        </Shell>
      } />
    </Routes>
  );
}
