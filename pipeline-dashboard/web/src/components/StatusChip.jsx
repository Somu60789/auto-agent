import Chip from '@mui/material/Chip';

const STATUS_CONFIG = {
  success: { label: 'success', color: 'success', variant: 'filled' },
  failure: { label: 'failure', color: 'error', variant: 'filled' },
  running: { label: 'running', color: 'warning', variant: 'filled' },
  none: { label: 'none', color: 'default', variant: 'outlined' },
  unknown: { label: 'unknown', color: 'default', variant: 'outlined' },
};

export default function StatusChip({ status, title }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
  return (
    <Chip
      size="small"
      label={cfg.label}
      color={cfg.color}
      variant={cfg.variant}
      title={title || ''}
    />
  );
}
