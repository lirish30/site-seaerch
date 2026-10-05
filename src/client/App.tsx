import { NavLink, Route, Routes } from "react-router-dom";
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

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/r/*" element={<Report />} />
      <Route path="*" element={
        <div className="shell">
          <nav className="nav">
            <strong>Site Search</strong>
            <NavLink to="/" end>New search</NavLink>
            <NavLink to="/leads">All leads</NavLink>
            <NavLink to="/promising">Promising</NavLink>
            <NavLink to="/import">Import</NavLink>
            <NavLink to="/radar">Radar</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <main>
            <Routes>
              <Route path="/" element={<NewSearch />} />
              <Route path="/searches/:id" element={<SearchDetail />} />
              <Route path="/leads" element={<AllLeads />} />
              <Route path="/leads/:id" element={<LeadDetail />} />
              <Route path="/promising" element={<Promising />} />
              <Route path="/import" element={<Import />} />
              <Route path="/radar" element={<Radar />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      } />
    </Routes>
  );
}
