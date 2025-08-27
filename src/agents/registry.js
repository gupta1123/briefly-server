// Simple agent registry to enable pluggable agents without persistence
export const agents = new Map();

export function registerAgent(name, impl) {
  agents.set(name, impl);
}

export function getAgent(name) {
  return agents.get(name);
}

export function listAgents() {
  return Array.from(agents.keys());
}

