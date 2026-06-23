import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import {
  listAgentRepos, listSessions, createSession, sendMessage, publishSession, streamSession,
} from '../api.js';

export default function CoWorker() {
  const [repos, setRepos] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [repoInput, setRepoInput] = useState('');
  const [session, setSession] = useState(null);
  const [events, setEvents] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [prUrl, setPrUrl] = useState(null);
  const esRef = useRef(null);

  function refreshSessions() {
    listSessions().then(setSessions).catch(() => {});
  }

  useEffect(() => {
    listAgentRepos().then(setRepos).catch(() => {});
    refreshSessions();
    return () => esRef.current?.close();
  }, []);

  function openStream(id) {
    if (esRef.current) esRef.current.close();
    setEvents([]);
    esRef.current = streamSession(
      id,
      (e) => setEvents((prev) => [...prev, e]),
      () => setError('Live connection lost — reload to reconnect.')
    );
  }

  async function start() {
    setError(null);
    setPrUrl(null);
    const refs = repoInput.split(',').map((s) => s.trim()).filter(Boolean);
    if (!refs.length) {
      setError('Enter at least one repo.');
      return;
    }
    try {
      const s = await createSession(refs, refs.join(', '));
      setSession(s);
      openStream(s.id);
      refreshSessions();
    } catch (err) {
      setError(err.message);
    }
  }

  function resume(s) {
    setError(null);
    setPrUrl(null);
    setSession(s);
    openStream(s.id);
  }

  async function send() {
    if (!session || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sendMessage(session.id, prompt);
      if (res?.error) setError(res.error);
      setPrompt('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function createPr() {
    setBusy(true);
    setError(null);
    try {
      const res = await publishSession(session.id, session.title, '');
      if (res.error) setError(res.error);
      else setPrUrl(res.prUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6">Co-Worker Agent</Typography>

      {!session && (
        <>
          <Stack direction="row" spacing={1} sx={{ my: 2 }}>
            <TextField
              fullWidth size="small"
              label="Repos (comma-separated names or GitHub links)"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              helperText={repos.length ? `Available: ${repos.join(', ')}` : 'No repos cloned yet'}
            />
            <Button variant="contained" onClick={start} disabled={!repoInput.trim()}>Start</Button>
          </Stack>
          {sessions.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                Past chats
              </Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                {sessions.map((s) => (
                  <Chip key={s.id} label={s.title || s.id} onClick={() => resume(s)} variant="outlined" />
                ))}
              </Stack>
            </Box>
          )}
        </>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {session && (
        <>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ my: 2 }}>
            <Typography variant="subtitle1">{session.title || session.id}</Typography>
            <Button size="small" onClick={() => { esRef.current?.close(); setSession(null); refreshSessions(); }}>
              ← Back
            </Button>
          </Stack>
          <Paper variant="outlined" sx={{ p: 2, mb: 2, maxHeight: 400, overflow: 'auto', fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {events.length === 0 && (
              <Box sx={{ color: 'text.secondary' }}>
                No messages yet — the conversation continues on your next message.
              </Box>
            )}
            {events.map((e, i) => (
              <Box key={i} sx={{ color: e.type === 'tool' ? 'primary.main' : e.error ? 'error.main' : 'text.primary' }}>
                {e.type === 'user' && <strong>&gt; {e.text}</strong>}
                {e.type === 'text' && e.text}
                {e.type === 'tool' && `[tool: ${e.name}]`}
                {e.type === 'result' && e.error && `Error: ${e.error}`}
              </Box>
            ))}
          </Paper>
          <Stack direction="row" spacing={1}>
            <TextField
              fullWidth size="small" multiline maxRows={4}
              placeholder="Ask the agent to make a change…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <Button variant="contained" onClick={send} disabled={busy || !prompt.trim()}>Send</Button>
            <Button variant="outlined" onClick={createPr} disabled={busy}>Create PR</Button>
          </Stack>
          {prUrl && (
            <Alert severity="success" sx={{ mt: 2 }}>
              PR opened: <a href={prUrl} target="_blank" rel="noreferrer">{prUrl}</a>
            </Alert>
          )}
        </>
      )}
    </Box>
  );
}
