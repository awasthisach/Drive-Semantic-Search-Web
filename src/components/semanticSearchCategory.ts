import type { DriveFile } from '../types';
import { canExtractText } from '../lib/contentExtract';

export function matchesSearchCategory(file: DriveFile, filter: string): boolean {
  if (!filter || filter === 'all') return true;
  if (filter === 'google_drive') return Boolean(file.isGoogleDriveItem);
  const mime = (file.mimeType || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (filter === 'document') {
    if (file.category === 'image') return false;
    if (mime.startsWith('image/')) return false;
    if (/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(name)) return false;
    if (file.category === 'document') return true;
    if (mime === 'application/vnd.google-apps.document') return true;
    if (mime.includes('wordprocessingml') || mime === 'application/msword') return true;
    if (mime === 'application/pdf' || name.endsWith('.pdf')) return true;
    if (mime.startsWith('text/') || /\.(txt|md|rtf|docx?)$/i.test(name)) return true;
    if (file.category === 'other' && canExtractText(file.mimeType, file.name) && !mime.startsWith('image/')) {
      return true;
    }
    return false;
  }
  if (filter === 'spreadsheet') {
    return (
      file.category === 'spreadsheet' ||
      mime === 'application/vnd.google-apps.spreadsheet' ||
      mime.includes('spreadsheetml') ||
      /\.(xlsx?|csv)$/i.test(name)
    );
  }
  if (filter === 'presentation') {
    return (
      mime === 'application/vnd.google-apps.presentation' ||
      mime.includes('presentationml') ||
      /\.(pptx?|odp)$/i.test(name)
    );
  }
  if (filter === 'pdf') {
    return mime === 'application/pdf' || name.endsWith('.pdf');
  }
  if (filter === 'image') {
    return file.category === 'image' || mime.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(name);
  }
  return file.category === filter;
}
