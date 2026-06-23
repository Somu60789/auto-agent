import axios from 'axios';

export async function fetchRepos() {
  const { data } = await axios.get('/api/repos');
  return data;
}

export async function refreshRepos() {
  const { data } = await axios.post('/api/refresh');
  return data;
}

export async function listAgentRepos() {
  const { data } = await axios.get('/api/agent/repos');
  return data.repos;
}

export async function listSessions() {
  const { data } = await axios.get('/api/agent/sessions');
  return data.sessions;
}

export async function createSession(repos, title) {
  const { data } = await axios.post('/api/agent/sessions', { repos, title });
  return data;
}

export async function sendMessage(id, prompt) {
  const { data } = await axios.post(`/api/agent/${id}/message`, { prompt });
  return data;
}

export async function publishSession(id, title, body) {
  const { data } = await axios.post(`/api/agent/${id}/publish`, { title, body });
  return data;
}

// Subscribe to a session's SSE stream. Returns the EventSource so the caller can close it.
export function streamSession(id, onEvent) {
  const es = new EventSource(`/api/agent/${id}/stream`);
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  return es;
}
