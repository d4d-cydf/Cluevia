import { useEffect } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import HomeScreen from './screens/HomeScreen';
import { CaseSidebarLayout } from './components/CaseSidebar';
import WorkspaceScreen from './screens/WorkspaceScreen';
import GraphWorkspace from './screens/GraphWorkspace';
import AnalysisWorkspace from './screens/AnalysisWorkspace';
import OntologyScreen from './screens/OntologyScreen';
import { clearAnalysisDraft } from './services/analysis-draft';

/** Explicit new-case actions clear only the local intake, never running server jobs. */
function NewCaseScreen() {
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    void clearAnalysisDraft().then(() => { if (active) navigate('/', { replace: true }); });
    return () => { active = false; };
  }, [navigate]);
  return <main className="empty-state" role="status">새 케이스를 준비하고 있습니다…</main>;
}

function CaseScreen() {
  const { id } = useParams();
  return id === '0143' ? <WorkspaceScreen /> : <GraphWorkspace />;
}

export default function App() {
  return <CaseSidebarLayout><Routes>
    <Route path="/" element={<HomeScreen />} />
    <Route path="/new" element={<NewCaseScreen />} />
    <Route path="/analysis/:jobId" element={<AnalysisWorkspace />} />
    <Route path="/ontology" element={<OntologyScreen />} />
    <Route path="/case/:id" element={<Navigate to="overview" replace />} />
    <Route path="/case/:id/:view" element={<CaseScreen />} />
    <Route path="*" element={<main className="empty-state"><p className="eyebrow">PAGE NOT FOUND</p><h1>This file is missing.</h1><Link to="/new">Open a new case →</Link></main>} />
  </Routes></CaseSidebarLayout>;
}
