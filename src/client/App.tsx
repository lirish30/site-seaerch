import { Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import NewSearch from "./pages/NewSearch";
import SearchDetail from "./pages/SearchDetail";
import LeadDetail from "./pages/LeadDetail";
import AllLeads from "./pages/AllLeads";
import Report from "./pages/Report";
import Radar from "./pages/Radar";
import Promising from "./pages/Promising";
import Import from "./pages/Import";
import Today from "./pages/Today";
import Jobs from "./pages/Jobs";
import Outreach from "./pages/Outreach";
import SearchHistory from "./pages/SearchHistory";
import SettingsHome from "./pages/settings/SettingsHome";
import Profile from "./pages/settings/Profile";
import JobSearch from "./pages/settings/JobSearch";
import Signature from "./pages/settings/Signature";
import Voice from "./pages/settings/Voice";
import WorkSamples from "./pages/settings/WorkSamples";
import Services from "./pages/settings/Services";
import FitProfiles from "./pages/settings/FitProfiles";
import Suppressions from "./pages/settings/Suppressions";
import Google from "./pages/settings/Google";
import Usage from "./pages/settings/Usage";
import Footer from "./pages/settings/Footer";
import Scores from "./pages/settings/Scores";
import Shell from "./components/Shell";

// Every page draws its own header and `.page-body` inside the panel.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/r/*" element={<Report />} />
      <Route path="*" element={
        <Shell>
          <Routes>
            <Route path="/" element={<NewSearch />} />
            <Route path="/searches" element={<SearchHistory />} />
            <Route path="/searches/:id" element={<SearchDetail />} />
            <Route path="/today" element={<Today />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/leads" element={<AllLeads />} />
            <Route path="/leads/:id" element={<LeadDetail />} />
            <Route path="/promising" element={<Promising />} />
            <Route path="/import" element={<Import />} />
            <Route path="/outreach" element={<Outreach />} />
            <Route path="/radar" element={<Radar />} />
            <Route path="/settings" element={<SettingsHome />} />
            <Route path="/settings/profile" element={<Profile />} />
            <Route path="/settings/job-search" element={<JobSearch />} />
            <Route path="/settings/signature" element={<Signature />} />
            <Route path="/settings/voice" element={<Voice />} />
            <Route path="/settings/work-samples" element={<WorkSamples />} />
            <Route path="/settings/services" element={<Services />} />
            <Route path="/settings/fit-profiles" element={<FitProfiles />} />
            <Route path="/settings/suppressions" element={<Suppressions />} />
            <Route path="/settings/google" element={<Google />} />
            <Route path="/settings/usage" element={<Usage />} />
            <Route path="/settings/footer" element={<Footer />} />
            <Route path="/settings/scores" element={<Scores />} />
          </Routes>
        </Shell>
      } />
    </Routes>
  );
}
