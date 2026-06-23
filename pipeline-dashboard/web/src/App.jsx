import { useEffect, useMemo, useState } from 'react';
import Container from '@mui/material/Container';
import AppBar from '@mui/material/AppBar';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import Box from '@mui/material/Box';
import { fetchRepos, refreshRepos } from './api.js';
import RepoTable from './components/RepoTable.jsx';
import DashboardToolbar from './components/DashboardToolbar.jsx';

export default function App() {
  const [data, setData] = useState({ repos: [], generatedAt: null, rateLimitRemaining: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      const result = refresh ? await refreshRepos() : await fetchRepos();
      setData(result);
    } catch (err) {
      setError(err.message || 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.repos;
    return data.repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [data.repos, query]);

  return (
    <Box>
      <AppBar position="static" color="default" elevation={1}>
        <DashboardToolbar
          total={data.repos.length}
          query={query}
          onQueryChange={setQuery}
          onRefresh={() => load(true)}
          loading={loading}
          generatedAt={data.generatedAt}
          rateLimitRemaining={data.rateLimitRemaining}
        />
      </AppBar>
      {loading && <LinearProgress />}
      <Container maxWidth={false} sx={{ py: 2 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <RepoTable repos={filtered} />
      </Container>
    </Box>
  );
}
