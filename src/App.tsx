import { Link, Navigate, Route, Routes } from 'react-router-dom';
import HomeScreen from './screens/HomeScreen';
import WorkspaceScreen from './screens/WorkspaceScreen';

export default function App() {
  return <Routes>
    <Route path="/" element={<HomeScreen />} />
    <Route path="/case/:id" element={<Navigate to="board" replace />} />
    <Route path="/case/:id/:view" element={<WorkspaceScreen />} />
    <Route path="*" element={<main className="empty-state"><p className="eyebrow">PAGE NOT FOUND</p><h1>This file is missing.</h1><Link to="/">Open a new case →</Link></main>} />
  </Routes>;
}
