import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import RefreshIcon from '@mui/icons-material/Refresh';

export default function DashboardToolbar({
  total,
  query,
  onQueryChange,
  onRefresh,
  loading,
  generatedAt,
  rateLimitRemaining,
}) {
  return (
    <Toolbar sx={{ gap: 2, flexWrap: 'wrap', py: 1 }}>
      <Typography variant="h6" sx={{ flexShrink: 0 }}>
        EP Pipeline Dashboard
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {total} repos
      </Typography>
      <TextField
        size="small"
        placeholder="Search repos…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <Box sx={{ flexGrow: 1 }} />
      <Typography variant="caption" color="text.secondary">
        {generatedAt ? `Updated ${new Date(generatedAt).toLocaleTimeString()}` : ''}
        {rateLimitRemaining != null ? ` · API left: ${rateLimitRemaining}` : ''}
      </Typography>
      <Button
        variant="contained"
        startIcon={<RefreshIcon />}
        onClick={onRefresh}
        disabled={loading}
      >
        Refresh
      </Button>
    </Toolbar>
  );
}
