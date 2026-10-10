import type { GraphDocument, GraphSelection } from '../types/graph.ts';

/** Rendering is bounded; the stored graph and exports retain every item. */
export function exploreGraph(graph: GraphDocument, options: { selection: GraphSelection; group: string; query: string; page: number; depth: number; limit?: number }) {
  const limit = Math.max(20, Math.min(300, options.limit ?? 200));
  const roots = new Set<string>();
  if (options.selection?.kind === 'node') roots.add(options.selection.id);
  if (options.selection?.kind === 'edge') { const edge = graph.edges.find(edge => edge.id === options.selection!.id); if (edge) { roots.add(edge.source); roots.add(edge.target); } }
  if (options.selection?.kind === 'event') graph.events.find(event => event.id === options.selection!.id)?.nodeIds.forEach(id => roots.add(id));
  let allowed: Set<string> | undefined;
  if (roots.size && options.depth > 0) {
    allowed = new Set(roots);
    for (let level = 0; level < options.depth; level++) {
      const previous = new Set(allowed);
      for (const edge of graph.edges) if (previous.has(edge.source) || previous.has(edge.target)) { allowed.add(edge.source); allowed.add(edge.target); }
    }
  }
  const query = options.query.trim().normalize('NFKC').toLocaleLowerCase();
  const matchingRelations = new Set(graph.edges.filter(edge => query && `${edge.label} ${edge.description}`.toLocaleLowerCase().includes(query)).flatMap(edge => [edge.source, edge.target]));
  for (const event of graph.events) if (query && `${event.label} ${event.description} ${event.date}`.toLocaleLowerCase().includes(query)) event.nodeIds.forEach(id => matchingRelations.add(id));
  const matches = graph.nodes.filter(node => roots.has(node.id) || ((!options.group || node.group === options.group) && (!allowed || allowed.has(node.id)) && (!query || allowed?.has(node.id) || matchingRelations.has(node.id) || `${node.label} ${node.type} ${node.description} ${Object.values(node.properties).join(' ')}`.normalize('NFKC').toLocaleLowerCase().includes(query))));
  const rootsInGraph = graph.nodes.filter(node => roots.has(node.id)).slice(0, Math.min(20, Math.floor(limit / 2)));
  const pinned = new Set(rootsInGraph.map(node => node.id));
  const other = matches.filter(node => !pinned.has(node.id));
  const capacity = limit - rootsInGraph.length;
  const pages = Math.max(1, Math.ceil(other.length / capacity)); const page = Math.min(Math.max(0, options.page), pages - 1);
  const nodes = [...rootsInGraph, ...other.slice(page * capacity, (page + 1) * capacity)];
  const ids = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  const relevance = (edge: GraphDocument['edges'][number]) => Number(edge.id === options.selection?.id) * 2 + Number(Boolean(query) && `${edge.label} ${edge.description}`.toLocaleLowerCase().includes(query));
  edges.sort((a, b) => relevance(b) - relevance(a));
  const events = graph.events.filter(event => event.nodeIds.some(id => ids.has(id)));
  const eventMatch = (event: GraphDocument['events'][number]) => Number(event.id === options.selection?.id) * 2 + Number(Boolean(query) && `${event.label} ${event.description} ${event.date}`.toLocaleLowerCase().includes(query));
  events.sort((a, b) => eventMatch(b) - eventMatch(a));
  const visibleEdges = edges.slice(0, 1000);
  return { graph: { ...graph, nodes, edges: visibleEdges, events: events.slice(0, 500), groups: graph.groups.filter(group => nodes.some(node => node.group === group.id)) }, page, pages, matching: matches.length, hiddenEdges: edges.length - visibleEdges.length };
}
