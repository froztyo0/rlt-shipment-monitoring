import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useParams } from "react-router-dom";
import DashboardPage from "./pages/DashboardPage";
import ShipmentDetailPage from "./pages/ShipmentDetailPage";
import OpsPage from "./pages/OpsPage";
import ReportsPage from "./pages/ReportsPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import BatchCohortsPage from "./pages/BatchCohortsPage";
import ETACalibrationPage from "./pages/ETACalibrationPage";
import ChokepointsPage from "./pages/ChokepointsPage";
import DeadReckoningPage from "./pages/DeadReckoningPage";

// key by tracking number so per-shipment state (e.g. the selected sales
// order) resets when navigating from one shipment straight to another
function ShipmentDetailRoute() {
  const { tracking = "" } = useParams();
  return <ShipmentDetailPage key={tracking} />;
}

function useTheme() {
  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem("theme") ?? "auto"
  );
  useEffect(() => {
    if (theme === "auto") {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("theme");
    } else {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem("theme", theme);
    }
  }, [theme]);
  return { theme, setTheme };
}

const navCls = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive ? "bg-s1 text-white" : "text-ink-2 hover:text-ink hover:bg-edge"
  }`;

export default function App() {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : theme === "light" ? "auto" : "dark";
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-[1100] border-b border-edge bg-surface-1/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center gap-4 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-s1" />
            <span className="text-[15px] font-semibold tracking-tight">
              RLT Shipment Monitoring
            </span>
          </div>
          <nav className="ml-4 flex items-center gap-1">
            <NavLink to="/" end className={navCls}>
              Dashboard
            </NavLink>
            <NavLink to="/analytics" className={navCls}>
              Analytics
            </NavLink>
            <NavLink to="/ops" className={navCls}>
              Ops Issues
            </NavLink>
            <NavLink to="/cohorts" className={navCls}>
              Batch Cohorts
            </NavLink>
            <NavLink to="/eta-calibration" className={navCls}>
              ETA Calibration
            </NavLink>
            <NavLink to="/chokepoints" className={navCls}>
              Chokepoints
            </NavLink>
            <NavLink to="/dead-reckoning" className={navCls}>
              Live ETA
            </NavLink>
            <NavLink to="/reports" className={navCls}>
              Reports
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-ink-3">read-only · etl schema</span>
            <button
              onClick={() => setTheme(next)}
              title={`Theme: ${theme} (click for ${next})`}
              className="rounded-md border border-edge px-2.5 py-1 text-xs text-ink-2 hover:text-ink"
            >
              {theme === "dark" ? "◐ dark" : theme === "light" ? "○ light" : "◑ auto"}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-4">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/ops" element={<OpsPage />} />
          <Route path="/cohorts" element={<BatchCohortsPage />} />
          <Route path="/eta-calibration" element={<ETACalibrationPage />} />
          <Route path="/chokepoints" element={<ChokepointsPage />} />
          <Route path="/dead-reckoning" element={<DeadReckoningPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/shipment/:tracking" element={<ShipmentDetailRoute />} />
        </Routes>
      </main>
    </div>
  );
}
