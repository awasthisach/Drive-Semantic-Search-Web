import { DriveFile, FileCategory, FolderItem } from '../types';

export const INITIAL_FOLDERS: FolderItem[] = [
  { id: 'finance', name: 'Financial Audits', color: 'emerald', description: 'Fiscal reports, spreadsheets and audits' },
  { id: 'projects', name: 'Work & Projects', color: 'blue', description: 'Product roadmaps, presentations and assets' },
  { id: 'design', name: 'Design Assets', color: 'purple', description: 'Wireframes, UI screenshots and prototypes' },
  { id: 'personal', name: 'Legal & Contracts', color: 'amber', description: 'Client master agreements and legal files' },
  { id: 'archive', name: 'Archive & Backups', color: 'zinc', description: 'Release packages and code backups' },
];

export const INITIAL_FILES: DriveFile[] = [
  {
    id: 'file-1',
    name: 'Q3_Financial_Audit_Report.pdf',
    mimeType: 'application/pdf',
    size: 4820000,
    modifiedTime: '2026-09-14T14:32:00Z',
    createdTime: '2026-08-01T09:00:00Z',
    category: 'document',
    folderId: 'finance',
    isOffline: true,
    isEncrypted: false,
    contentHash: 'a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6',
    tags: ['finance', 'audit', 'confidential', 'q3'],
    semanticSummary: 'Comprehensive Q3 fiscal audit documenting revenue growth, EBITDA margin adjustments, tax write-offs, and risk governance.',
    starred: true,
  },
  {
    id: 'file-2',
    name: 'San_Francisco_Team_Offsite.jpg',
    mimeType: 'image/jpeg',
    size: 7420000,
    modifiedTime: '2026-09-12T11:15:00Z',
    createdTime: '2026-09-12T11:15:00Z',
    category: 'image',
    folderId: 'projects',
    thumbnailUrl: 'https://images.unsplash.com/photo-1506146332389-18140dc7b2fb?w=480&auto=format&fit=crop&q=75',
    isOffline: true,
    isEncrypted: false,
    contentHash: '992b4fa267c8e54826b1c41198f3992b4fa267c8',
    tags: ['team', 'photo', 'offsite', 'san francisco'],
    semanticSummary: 'High-resolution landscape photo of engineering leads during the golden gate team offsite brainstorming session.',
    starred: false,
  },
  {
    id: 'file-3',
    name: 'San_Francisco_Team_Offsite (Copy 1).jpg',
    mimeType: 'image/jpeg',
    size: 7420000,
    modifiedTime: '2026-09-13T08:20:00Z',
    createdTime: '2026-09-13T08:20:00Z',
    category: 'image',
    folderId: 'projects',
    thumbnailUrl: 'https://images.unsplash.com/photo-1506146332389-18140dc7b2fb?w=480&auto=format&fit=crop&q=75',
    isOffline: false,
    isEncrypted: false,
    contentHash: '992b4fa267c8e54826b1c41198f3992b4fa267c8',
    tags: ['team', 'duplicate', 'photo'],
    semanticSummary: 'Identical duplicate copy of team offsite photography stored in downloads sync folder.',
    starred: false,
  },
  {
    id: 'file-4',
    name: 'Executive_Board_Deck_2026.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 12800000,
    modifiedTime: '2026-09-15T18:45:00Z',
    createdTime: '2026-09-02T10:00:00Z',
    category: 'document',
    folderId: 'projects',
    isOffline: true,
    isEncrypted: false,
    contentHash: 'f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5',
    tags: ['executive', 'board', 'strategy', 'pitch'],
    semanticSummary: 'Slide presentation reviewing multi-cloud architecture expansion, zero-trust security postures, and Q4 product roadmaps.',
    starred: true,
  },
  {
    id: 'file-5',
    name: 'Client_Contracts_Master_Vault.aes',
    mimeType: 'application/octet-stream',
    size: 3100000,
    modifiedTime: '2026-09-10T16:00:00Z',
    createdTime: '2026-09-10T16:00:00Z',
    category: 'document',
    folderId: 'personal',
    isOffline: true,
    isEncrypted: true,
    contentHash: 'e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6',
    tags: ['vault', 'encrypted', 'contracts', 'legal'],
    semanticSummary: 'Zero-knowledge AES-256 encrypted payload containing customer enterprise master services agreements and SLA commitments.',
    starred: true,
  },
  {
    id: 'file-6',
    name: 'UI_Wireframe_Mobile_Tablet.png',
    mimeType: 'image/png',
    size: 5120000,
    modifiedTime: '2026-09-16T09:12:00Z',
    createdTime: '2026-09-15T14:30:00Z',
    category: 'image',
    folderId: 'design',
    thumbnailUrl: 'https://images.unsplash.com/photo-1581291518857-4e27b48ff24e?w=480&auto=format&fit=crop&q=75',
    isOffline: false,
    isEncrypted: false,
    contentHash: 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0',
    tags: ['ui', 'wireframe', 'mobile', 'tablet', 'design'],
    semanticSummary: 'High-fidelity Figma export displaying adaptive layout wireframes for mobile portrait, landscape, and 10-inch tablets.',
    starred: false,
  },
  {
    id: 'file-7',
    name: 'Global_Sales_Projections_2026.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 2150000,
    modifiedTime: '2026-09-11T20:10:00Z',
    createdTime: '2026-07-20T11:00:00Z',
    category: 'spreadsheet',
    folderId: 'finance',
    isOffline: false,
    isEncrypted: false,
    contentHash: 'b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3',
    tags: ['sales', 'projection', 'spreadsheet', 'revenue'],
    semanticSummary: 'Multi-tab spreadsheet detailing regional ARR forecasts, churn rates, and quota attainment percentages.',
    starred: false,
  },
  {
    id: 'file-8',
    name: 'Global_Sales_Projections_2026 (1).xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 2150000,
    modifiedTime: '2026-09-11T20:15:00Z',
    createdTime: '2026-09-11T20:15:00Z',
    category: 'spreadsheet',
    folderId: 'finance',
    isOffline: false,
    isEncrypted: false,
    contentHash: 'b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3',
    tags: ['sales', 'duplicate', 'spreadsheet'],
    semanticSummary: 'Unmodified duplicate copy of sales spreadsheet synced from secondary workstation.',
    starred: false,
  },
  {
    id: 'file-9',
    name: 'Source_Code_Backup_v2.4.zip',
    mimeType: 'application/zip',
    size: 24600000,
    modifiedTime: '2026-09-08T17:22:00Z',
    createdTime: '2026-09-08T17:22:00Z',
    category: 'archive',
    folderId: 'archive',
    isOffline: true,
    isEncrypted: false,
    contentHash: 'd3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4',
    tags: ['code', 'backup', 'zip', 'release'],
    semanticSummary: 'Compressed archive containing full frontend build artifacts, worker threads, and crypto verification test suites.',
    starred: false,
  },
];

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return 'Size unknown';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function getCategoryFromMime(mimeType: string, filename: string): FileCategory {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('text/plain')) return 'document';
  if (mimeType.includes('sheet') || mimeType.includes('csv') || filename.endsWith('.xlsx')) return 'spreadsheet';
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('gzip')) return 'archive';
  if (mimeType.includes('javascript') || mimeType.includes('typescript') || filename.endsWith('.ts') || filename.endsWith('.tsx') || filename.endsWith('.json')) return 'code';
  return 'other';
}
