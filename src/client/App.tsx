import { Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import NewSearch from "./pages/NewSearch";
import SearchDetail from "./pages/SearchDetail";
import LeadDetail from "./pages/LeadDetail";
import VideoEditor from "./pages/VideoEditor";
import AllLeads from "./pages/AllLeads";
import Report from "./pages/Report";
import Radar from "./pages/Radar";
import Promising from "./pages/Promising";
import Import from "./pages/Import";
import Today from "./pages/Today";
import Outreach from "./pages/Outreach";
import SearchHistory from "./pages/SearchHistory";
import SettingsHome from "./pages/settings/SettingsHome";
import Profile from "./pages/settings/Profile";
import Signature from "./pages/settings/Signature";
import Voice from "./pages/settings/Voice";
import WorkSamples from "./pages/settings/WorkSamples";
import Services from "./pages/settings/Services";
import FitProfiles from "./pages/settings/FitProfiles";
import Suppressions from "./pages/settings/Suppressions";
import Mailboxes from "./pages/settings/Mailboxes";
import Campaigns from "./pages/Campaigns";
import Pipeline from "./pages/Pipeline";
import DealPage from "./pages/Deal";
import DeckPage from "./pages/Deck";
import NicheTest from "./pages/NicheTest";
import Google from "./pages/settings/Google";
import Usage from "./pages/settings/Usage";
import Security from "./pages/settings/Security";
import Footer from "./pages/settings/Footer";
import Helper from "./pages/settings/Helper";
import VoiceTest from "./pages/settings/VoiceTest";
import Scores from "./pages/settings/Scores";
import Packages from "./pages/settings/Packages";
import Booking from "./pages/settings/Booking";
import Documents from "./pages/settings/Documents";
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
            <Route path="/leads" element={<AllLeads />} />
            <Route path="/leads/:id" element={<LeadDetail />} />
            <Route path="/leads/:id/video" element={<VideoEditor />} />
            <Route path="/promising" element={<Promising />} />
            <Route path="/import" element={<Import />} />
            <Route path="/outreach" element={<Outreach />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/deals/:id" element={<DealPage />} />
            <Route path="/deals/:id/deck" element={<DeckPage />} />
            <Route path="/radar" element={<Radar />} />
            <Route path="/niche-test" element={<NicheTest />} />
            <Route path="/settings" element={<SettingsHome />} />
            <Route path="/settings/profile" element={<Profile />} />
            <Route path="/settings/signature" element={<Signature />} />
            <Route path="/settings/voice" element={<Voice />} />
            <Route path="/settings/work-samples" element={<WorkSamples />} />
            <Route path="/settings/services" element={<Services />} />
            <Route path="/settings/fit-profiles" element={<FitProfiles />} />
            <Route path="/settings/suppressions" element={<Suppressions />} />
            <Route path="/settings/mailboxes" element={<Mailboxes />} />
            <Route path="/settings/google" element={<Google />} />
            <Route path="/settings/usage" element={<Usage />} />
            <Route path="/settings/security" element={<Security />} />
            <Route path="/settings/footer" element={<Footer />} />
            <Route path="/settings/helper" element={<Helper />} />
            <Route path="/settings/voice-test" element={<VoiceTest />} />
            <Route path="/settings/scores" element={<Scores />} />
            <Route path="/settings/packages" element={<Packages />} />
            <Route path="/settings/booking" element={<Booking />} />
            <Route path="/settings/documents" element={<Documents />} />
          </Routes>
        </Shell>
      } />
    </Routes>
  );
}
