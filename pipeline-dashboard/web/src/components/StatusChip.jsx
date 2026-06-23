import Chip from '@mui/material/Chip';

// Known statuses get a color + variant. Any other GitHub run conclusion
// (e.g. cancelled, action_required, timed_out) is shown with its real label
// rather than being flattened to "unknown".
const STATUS_CONFIG = {
  success: { color: 'success', variant: 'filled' },
  failure: { color: 'error', variant: 'filled' },
  running: { color: 'warning', variant: 'filled' },
  cancelled: { color: 'default', variant: 'outlined' },
  action_required: { color: 'warning', variant: 'outlined' },
  none: { color: 'default', variant: 'outlined' },
  unknown: { color: 'default', variant: 'outlined' },
};

export default function StatusChip({ status, title }) {
  const label = status || 'unknown';
  const cfg = STATUS_CONFIG[label] || { color: 'default', variant: 'outlined' };
  return (
    <Chip
      size="small"
      label={label}
      color={cfg.color}
      variant={cfg.variant}
      title={title || ''}
    />
  );
}
