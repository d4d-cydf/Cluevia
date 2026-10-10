import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import HomeScreen from './screens/HomeScreen';
import { CaseSidebarLayout } from './components/CaseSidebar';
import WorkspaceScreen from './screens/WorkspaceScreen';
import GraphWorkspace from './screens/GraphWorkspace';
import AnalysisWorkspace from './screens/AnalysisWorkspace';
import OntologyScreen from './screens/OntologyScreen';

function CaseScreen() {
  const { id } = useParams();
  return id === '0143' ? <WorkspaceScreen /> : <GraphWorkspace />;
}

export default function App() {
  return <CaseSidebarLayout><Routes>
    <Route path="/" element={<HomeScreen />} />
    <Route path="/analysis/:jobId" element={<AnalysisWorkspace />} />
    <Route path="/ontology" element={<OntologyScreen />} />
    <Route path="/case/:id" element={<Navigate to="board" replace />} />
    <Route path="/case/:id/:view" element={<CaseScreen />} />
    <Route path="*" element={<main className="empty-state"><p className="eyebrow">PAGE NOT FOUND</p><h1>This file is missing.</h1><Link to="/">Open a new case →</Link></main>} />
  </Routes></CaseSidebarLayout>;
}
