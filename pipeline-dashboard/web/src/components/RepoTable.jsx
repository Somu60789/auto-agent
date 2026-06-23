import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import Paper from '@mui/material/Paper';
import Link from '@mui/material/Link';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useState } from 'react';
import StatusChip from './StatusChip.jsx';

const BOOL_COLUMNS = [
  { key: 'inPipelines', label: 'In Pipelines' },
  { key: 'clonedLocally', label: 'Cloned' },
  { key: 'githubActions', label: 'GH Actions' },
  { key: 'jenkins', label: 'Jenkins' },
  { key: 'dockerfile', label: 'Dockerfile' },
];

function BoolCell({ value }) {
  return value ? (
    <CheckCircleIcon fontSize="small" color="success" titleAccess="yes" />
  ) : (
    <CancelIcon fontSize="small" color="disabled" titleAccess="no" />
  );
}

export default function RepoTable({ repos }) {
  const [orderBy, setOrderBy] = useState('fullName');
  const [order, setOrder] = useState('asc');

  const handleSort = (key) => {
    if (orderBy === key) {
      setOrder(order === 'asc' ? 'desc' : 'asc');
    } else {
      setOrderBy(key);
      setOrder('asc');
    }
  };

  const sorted = [...repos].sort((a, b) => {
    const av = a[orderBy];
    const bv = b[orderBy];
    let cmp;
    if (orderBy === 'latestBuild') {
      cmp = String(a.latestBuild?.status).localeCompare(String(b.latestBuild?.status));
    } else if (typeof av === 'boolean') {
      cmp = av === bv ? 0 : av ? -1 : 1;
    } else {
      cmp = String(av).localeCompare(String(bv));
    }
    return order === 'asc' ? cmp : -cmp;
  });

  return (
    <TableContainer component={Paper}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell sortDirection={orderBy === 'fullName' ? order : false}>
              <TableSortLabel
                active={orderBy === 'fullName'}
                direction={orderBy === 'fullName' ? order : 'asc'}
                onClick={() => handleSort('fullName')}
              >
                Repo
              </TableSortLabel>
            </TableCell>
            {BOOL_COLUMNS.map((col) => (
              <TableCell key={col.key} align="center">
                <TableSortLabel
                  active={orderBy === col.key}
                  direction={orderBy === col.key ? order : 'asc'}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                </TableSortLabel>
              </TableCell>
            ))}
            <TableCell>
              <TableSortLabel
                active={orderBy === 'latestBuild'}
                direction={orderBy === 'latestBuild' ? order : 'asc'}
                onClick={() => handleSort('latestBuild')}
              >
                Latest Build
              </TableSortLabel>
            </TableCell>
            <TableCell>Link</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map((repo) => (
            <TableRow key={repo.fullName} hover>
              <TableCell>{repo.name}</TableCell>
              {BOOL_COLUMNS.map((col) => (
                <TableCell key={col.key} align="center">
                  <BoolCell value={repo[col.key]} />
                </TableCell>
              ))}
              <TableCell>
                <StatusChip
                  status={repo.latestBuild?.status || 'unknown'}
                  title={repo.error || ''}
                />
              </TableCell>
              <TableCell>
                <Link href={repo.url} target="_blank" rel="noopener">
                  <OpenInNewIcon fontSize="small" />
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
