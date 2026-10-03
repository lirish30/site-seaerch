import { NavLink, Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import NewSearch from "./pages/NewSearch";
import SearchDetail from "./pages/SearchDetail";
import LeadDetail from "./pages/LeadDetail";
import AllLeads from "./pages/AllLeads";
import Settings from "./pages/Settings";
import Report from "./pages/Report";

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
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <main>
            <Routes>
              <Route path="/" element={<NewSearch />} />
              <Route path="/searches/:id" element={<SearchDetail />} />
              <Route path="/leads" element={<AllLeads />} />
              <Route path="/leads/:id" element={<LeadDetail />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      } />
    </Routes>
  );
}
