import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import HomeScreen from './screens/HomeScreen';
import WorkspaceScreen from './screens/WorkspaceScreen';
import GraphWorkspace from './screens/GraphWorkspace';

function CaseScreen() {
  const { id } = useParams();
  return id === '0143' ? <WorkspaceScreen /> : <GraphWorkspace />;
}

export default function App() {
  return <Routes>
    <Route path="/" element={<HomeScreen />} />
    <Route path="/case/:id" element={<Navigate to="board" replace />} />
    <Route path="/case/:id/:view" element={<CaseScreen />} />
    <Route path="*" element={<main className="empty-state"><p className="eyebrow">PAGE NOT FOUND</p><h1>This file is missing.</h1><Link to="/">Open a new case →</Link></main>} />
  </Routes>;
}
