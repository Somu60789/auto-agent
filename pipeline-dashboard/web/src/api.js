import axios from 'axios';

export async function fetchRepos() {
  const { data } = await axios.get('/api/repos');
  return data;
}

export async function refreshRepos() {
  const { data } = await axios.post('/api/refresh');
  return data;
}
